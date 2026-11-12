import { existsSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { paths, repositoryBinding, siblingWorktreeFolder } from "../../config";
import { publicTaskStatus } from "../../protocol/task";
import { workspaces, projectIdentity, conversationTurnHeld, conversationTurnLock } from "../data/projects";
import { existingTasks, purgeTasks } from "../data/tasks";
import { listProcesses, listVerifications, processCleanupBlocker, processInspection, processOwner } from "../data/processes";
import { pendingCount } from "../data/inbox";
import { pendingImageInputs } from "../data/images";
import { open as openTranscript } from "../data/transcripts";
import { tryStorageLock } from "../data";
import { run } from "../proc";
import { agentActivity } from "./activity";
import { sessionId } from "./runner";
import { discoverWorkspaces } from "./workspace-inventory";
import { cacheBlocker, discoverBuildCaches } from "./workspace-caches";
import { allocatedBytes, checkoutFiles, removeGenerated, removeResource, resourcePaths } from "./workspace-disposal";

export interface CleanupResult { path: string; disposition: string; session?: string; bytes?: number }
export interface CleanupOptions {
  now?: number;
  activity?: typeof agentActivity;
  openPaths?: () => Promise<string[] | null>;
  cacheRoots?: string[];
}
async function localOpenPaths(): Promise<string[] | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const found = await run(["lsof", "-nP", "-a", "-u", String(uid), "-d", "cwd,txt", "-Fn"], { cwd: paths.root, timeoutMs: 15_000 });
  return found?.code === 0 && !found.err.trim() ? found.out.split("\n").filter(s => s.startsWith("n")).map(s => s.slice(1)) : null;
}
function guards(options: CleanupOptions) {
  const owned = new Map<string, workspaces.Resource[]>();
  for (const r of workspaces.resources()) for (const id of r.owners) {
    if (!owned.has(id)) owned.set(id, []);
    owned.get(id)!.push(r);
  }
  const projects = new Map<string, Promise<{ activity: Awaited<ReturnType<typeof agentActivity>>; processes: Awaited<ReturnType<typeof listProcesses>>; sandboxes: Awaited<ReturnType<typeof listVerifications>> }>>();
  let opened: Promise<string[] | null> | undefined;
  const inspect = processInspection();
  const check = async (w: workspaces.Workspace, turnLocksHeld: boolean): Promise<string | undefined> => {
    if (existsSync(w.path) && workspaces.fingerprint(w.path) !== w.fingerprint) return "workspace directory identity changed";
    const resources = owned.get(w.id) ?? [];
    for (const member of w.members) {
      if (!existsSync(paths.project(member.project)) || projectIdentity(member.project) !== member.identity) return "conversation identity changed or was removed";
      if (!projects.has(member.project)) projects.set(member.project, Promise.all([(options.activity ?? agentActivity)(member.project), listProcesses(member.project), listVerifications(member.project)])
        .then(([activity, processes, sandboxes]) => ({ activity, processes, sandboxes })));
      const { activity, processes, sandboxes } = await projects.get(member.project)!;
      if (!activity.inventoryComplete) return "agent inventory unavailable";
      const agents = new Set(resources.filter(r => r.project === member.project && r.kind === "agent").map(r => r.key));
      const tasks = new Set(resources.filter(r => r.project === member.project && r.kind === "task").map(r => r.key));
      if (existingTasks(member.project).some(t => (tasks.has(t.id) || (w.disposable && t.branch === w.branch)) && t.updatedAt > w.lastActivityAt)) return "task changed during inspection";
      for (const row of activity.agents) if (!w.disposable || agents.has(row.agent) || row.record?.branch === w.branch) {
        if (row.status !== "exited" || row.queuedMessages !== 0) return "agent activity or queued work";
      }
      if (agents.has("orchestrator") && ((!turnLocksHeld && await conversationTurnHeld(member.project)) || await pendingCount(member.project, "orchestrator"))) return "orchestrator activity or queued work";
      const transcript = paths.transcript(member.project, "orchestrator");
      if (agents.has("orchestrator") && (await pendingImageInputs(member.project, existsSync(transcript) ? openTranscript(transcript).consumed?.().inputs : undefined)).length) return "saved image input is still pending";
      for (const p of processes) if (p.workspaceSession === w.id || p.cwd === w.path || agents.has(p.owner) || agents.has(processOwner(p))) {
        const reason = processCleanupBlocker(p, undefined, inspect);
        if (reason) return reason;
        if (p.custody?.pending) return "command handoff delivery is incomplete";
        if (p.notify && p.events.some(e => !e.delivered)) return "undelivered command completion";
      }
      if (sandboxes.some(v => v.state !== "closed" && (v.source === w.path || resources.some(r => r.project === member.project && r.kind === "sandbox" && r.key === v.id)))) return "sandbox cleanup is incomplete";
    }
    for (const r of resources.filter(r => r.kind === "cache")) { const reason = await cacheBlocker(r); if (reason) return reason; }
    opened ??= (options.openPaths ?? localOpenPaths)();
    const open = await opened;
    if (open === null) return "local process inspection unavailable";
    const roots = [w.path, ...resources.filter(r => r.kind === "cache" && r.path).map(r => r.path!)];
    if (open.some(path => roots.some(root => path === root || path.startsWith(root + sep)))) return "local process uses workspace or build cache";
  };
  return async (w: workspaces.Workspace, turnLocksHeld = false): Promise<string | undefined> => {
    try { return await check(w, turnLocksHeld); }
    catch (error) { return `inspection failed (${error})`; }
  };
}

/** Maintenance only discovers and archives. It never deletes storage, invokes
 * a model or starts work. Only the explicit clean command performs permanent cleanup. */
export async function archiveInactiveWorkspaces(project: string, options: CleanupOptions = {}): Promise<void> {
  const now = options.now ?? Date.now();
  if (workspaces.list().some(w => w.cleaning && w.members.some(m => m.project === project))) return;
  if (existsSync(paths.project(project))) await discoverWorkspaces(project, now);
  const check = guards(options);
  for (const w of workspaces.list().filter(w => !w.cleanedAt && !w.archivedAt && w.members.some(m => m.project === project))) {
    if (now - Date.parse(w.lastActivityAt) < workspaces.INACTIVE_MS) continue;
    if (!await check(w)) workspaces.archive(w.id, w.lastActivityAt, now);
  }
}
async function hold(names: string[]): Promise<() => Promise<void>> {
  const held: (() => Promise<void>)[] = [];
  try {
    for (const name of [...new Set(names)].sort()) {
      const release = await tryStorageLock(name, "workspace cleanup");
      if (!release) throw new Error("workspace is being used or cleaned");
      held.push(release);
    }
    return async () => { for (const release of held.reverse()) await release(); };
  } catch (e) { for (const release of held.reverse()) await release(); throw e; }
}
const cleanupLock = (w: workspaces.Workspace) => join(paths.runtime, "workspace-cleanup", w.id);
const spawnLocks = (w: workspaces.Workspace) => w.disposable && w.branch
  ? w.members.map(m => join(paths.runtimeProject(m.project), "spawn-locks", sessionId("worker", w.branch!))) : [];
const locks = (w: workspaces.Workspace) => hold([cleanupLock(w), ...w.members.map(m => conversationTurnLock(m.project)), ...spawnLocks(w)]);

/** Nothing is removed while its work may have just ended: a follow-up spawn reuses the checkout. */
export const FINISHED_GRACE_MS = 10 * 60_000;
/** Why a worker checkout's work is over, or undefined. `settled`: every task on the branch is
 * merged, closed or removed, so its session can be archived too. Without a settled task (a repo
 * with no remote has no PR to observe), the branch must have moved since it was created and be
 * contained in the default branch; a branch nobody committed to proves nothing. */
async function finishedWork(w: workspaces.Workspace): Promise<{ why: string; settled: boolean } | undefined> {
  if (!w.disposable || !w.branch || !w.repo) return;
  const tasks = w.members.flatMap(m => existingTasks(m.project).filter(t => t.branch === w.branch));
  const states = tasks.map(t => t.removedAt ? "removed" : publicTaskStatus(t));
  const settled = states.every(s => s === "merged" || s === "closed" || s === "removed");
  if (tasks.length && settled) return { why: states.includes("merged") ? "its PR merged" : "its task is closed", settled };
  const base = w.members.map(m => repositoryBinding(m.project)?.branch).find(Boolean);
  if (!base || base === w.branch) return;
  const git = (...args: string[]) => run(["git", ...args], { cwd: w.repo!, timeoutMs: 10_000 });
  const contained = await git("merge-base", "--is-ancestor", `refs/heads/${w.branch}`, `refs/heads/${base}`);
  if (contained?.code !== 0) return;
  const moves = await git("reflog", "show", "--format=%H", `refs/heads/${w.branch}`);
  if (moves?.code !== 0 || moves.out.trim().split("\n").filter(Boolean).length < 2) return;
  return { why: `its branch is merged into ${base}`, settled: !tasks.length };
}

/** The daemon's maintenance pass: remove the checkout of finished work, and nothing else. The
 * branch and its commits, the agent's transcript and the task record all stay; a session whose
 * tasks are settled is archived, so the explicit clean command may purge those records later.
 * Kept when anything is live, queued or open, when the checkout has source edits, untracked or
 * unrecognised ignored files, or when it cannot be inspected. Never stops or starts an agent. */
export async function removeFinishedWorktrees(project: string, options: CleanupOptions = {}): Promise<CleanupResult[]> {
  const now = options.now ?? Date.now(), result: CleanupResult[] = [];
  if (!existsSync(paths.project(project)) || workspaces.list().some(w => w.cleaning && w.members.some(m => m.project === project))) return result;
  await discoverWorkspaces(project, now);
  const check = guards(options);
  for (const candidate of workspaces.list().filter(w => w.disposable && !w.cleanedAt && w.members.some(m => m.project === project) && existsSync(w.path))) {
    if (now - Date.parse(candidate.lastActivityAt) < FINISHED_GRACE_MS) continue;
    const row = (disposition: string, bytes?: number) => result.push({ path: candidate.path, session: candidate.id, disposition, ...(bytes !== undefined ? { bytes } : {}) });
    let release: (() => Promise<void>) | undefined;
    try {
      if (!await finishedWork(candidate)) continue;
      // A spawn on this branch holds the same lock, so none can start between the checks and the removal.
      release = await hold([cleanupLock(candidate), ...spawnLocks(candidate)]);
      const w = workspaces.get(candidate.id)!;
      if (w.cleaning || w.cleanedAt || w.lastActivityAt !== candidate.lastActivityAt) continue;
      const finished = await finishedWork(w);
      if (!finished) continue;
      const reason = await check(w) ?? (await checkoutFiles(w)).blocker;
      if (reason) { row(`kept: ${reason}`); continue; }
      const bytes = await allocatedBytes(w.path);
      const removed = await run(["git", "worktree", "remove", "--force", "--", w.path], { cwd: w.repo!, timeoutMs: 60_000 });
      if (!removed || removed.code !== 0) { row("kept: git could not remove checkout"); continue; }
      const namespace = dirname(w.path);
      if (await rmdir(namespace).then(() => true, () => false) && siblingWorktreeFolder(dirname(namespace))) await rmdir(dirname(namespace)).catch(() => {});
      if (finished.settled) workspaces.archive(w.id, w.lastActivityAt, now, true);
      row(`removed worktree: ${finished.why}; branch ${w.branch} kept`, bytes);
    } catch (e) { row(`kept: ${e instanceof Error ? e.message : String(e)}`); }
    finally { await release?.(); }
  }
  return result;
}

/** Preview by default. Checked worktrees retain their local Git branches,
 * including unmerged commits; existing user directories are never removed. */
export async function cleanManagedWorkspaces(project: string, apply = false, options: CleanupOptions = {}): Promise<CleanupResult[]> {
  const execute = async () => {
    await archiveInactiveWorkspaces(project, options);
    const issues = await discoverBuildCaches(options.cacheRoots, project);
    return [...issues, ...await cleanRegistered(project, apply, options)];
  };
  return apply ? execute() : workspaces.preview(execute);
}
async function cleanRegistered(project: string, apply: boolean, options: CleanupOptions): Promise<CleanupResult[]> {
  const result: CleanupResult[] = [], check = guards(options);
  for (const candidate of workspaces.list().filter(w => !w.cleanedAt && w.members[0]?.project === project)) {
    const row = (disposition: string, bytes?: number) => result.push({ path: candidate.path, session: candidate.id, disposition, ...(bytes !== undefined ? { bytes } : {}) });
    if (!candidate.archivedAt) {
      const reason = (options.now ?? Date.now()) - Date.parse(candidate.lastActivityAt) >= workspaces.INACTIVE_MS ? await check(candidate) : undefined;
      row(`kept: ${reason ?? "session is not archived"}`); continue;
    }
    let release: (() => Promise<void>) | undefined, claimed = false;
    try {
      if (apply) release = await locks(candidate);
      const w = workspaces.get(candidate.id)!;
      const reason = await check(w, apply);
      if (reason) { row(`kept: ${reason}`); continue; }
      if (apply) { workspaces.claim(w.id, w.lastActivityAt); claimed = true; }
      const files = await checkoutFiles(w);
      if (files.blocker) {
        const bytes = (await Promise.all(files.generated.map(allocatedBytes))).reduce((a, b) => a + b, 0);
        if (apply) {
          const changed = await guards(options)(w, true);
          if (changed) { row(`kept: ${changed}`); continue; }
          await removeGenerated(w, files.generated);
        }
        row(`kept: ${files.blocker}; ${apply ? "removed" : "eligible:"} disposable build files only`, bytes);
        continue;
      }
      const resources = workspaces.resources(w.id), unique = resources.filter(r => r.owners.length === 1);
      const locations = [...(w.disposable ? [w.path] : []), ...(await Promise.all(unique.map(resourcePaths))).flat()];
      const distinct = [...new Set(locations)].filter(path => !locations.some(other => other !== path && path.startsWith(other + sep)));
      const bytes = (await Promise.all(distinct.map(allocatedBytes))).reduce((a, b) => a + b, 0);
      if (!apply) { row("eligible: archived workspace and owned resources", bytes); continue; }
      const changed = await guards(options)(w, true);
      if (changed) { row(`kept: ${changed}`); continue; }
      const blockers: string[] = [];
      for (const r of resources.filter(r => r.owners.length > 1)) workspaces.forget(w.id, r);
      for (const member of w.members) {
        const tasks = unique.filter(r => r.kind === "task" && r.project === member.project);
        if (tasks.length) try {
          await purgeTasks(member.project, tasks.map(r => r.key));
          for (const r of tasks) workspaces.forget(w.id, r);
        } catch (e) { blockers.push(String(e)); }
      }
      const order = (r: workspaces.Resource) => r.kind === "agent" ? 0 : r.kind === "image" ? 2 : 1;
      for (const r of unique.filter(r => r.kind !== "task").sort((a, b) => order(a) - order(b))) {
        try {
          const kept = await removeResource(r);
          if (kept) blockers.push(`${r.kind} ${r.key}: ${kept}`); else workspaces.forget(w.id, r);
        } catch (e) { blockers.push(`${r.kind} ${r.key}: ${e}`); }
      }
      if (w.disposable && existsSync(w.path)) {
        const final = await checkoutFiles(w);
        if (final.blocker) blockers.push(final.blocker);
        else {
          const removed = await run(["git", "worktree", "remove", "--force", "--", w.path], { cwd: w.repo!, timeoutMs: 60_000 });
          if (!removed || removed.code !== 0) blockers.push("git could not remove checkout");
        }
      }
      const complete = !blockers.length && !workspaces.resources(w.id).length;
      workspaces.finish(w.id, complete); claimed = false;
      row(complete ? "removed archived session" : `partial: ${blockers.join("; ")}`, bytes);
    } catch (e) { row(`kept: ${e instanceof Error ? e.message : String(e)}`); }
    finally { if (claimed) workspaces.finish(candidate.id, false); await release?.(); }
  }
  return result;
}
