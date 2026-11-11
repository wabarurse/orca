import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { paths } from "../../config";
import { workspaces, projectIdentity, conversationTurnHeld, conversationTurnLock } from "../data/projects";
import { existingTasks, purgeTasks } from "../data/tasks";
import { listProcesses, listVerifications, processCleanupBlocker } from "../data/processes";
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
  return async (w: workspaces.Workspace, turnLocksHeld = false): Promise<string | undefined> => {
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
      for (const p of processes) if (p.workspaceSession === w.id || p.cwd === w.path || agents.has(p.owner)) {
        const reason = processCleanupBlocker(p);
        if (reason) return reason;
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
}

/** Maintenance only discovers and archives. It never deletes storage, invokes
 * a model or starts work. Only explicit --apply performs permanent cleanup. */
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
async function locks(w: workspaces.Workspace): Promise<() => Promise<void>> {
  const held: (() => Promise<void>)[] = [];
  try {
    const names = [join(paths.runtime, "workspace-cleanup", w.id), ...w.members.flatMap(m => [conversationTurnLock(m.project),
      ...(w.disposable && w.branch ? [join(paths.runtimeProject(m.project), "spawn-locks", sessionId("worker", w.branch))] : [])])];
    for (const name of [...new Set(names)].sort()) {
      const release = await tryStorageLock(name, "workspace cleanup");
      if (!release) throw new Error("workspace is being used or cleaned");
      held.push(release);
    }
    return async () => { for (const release of held.reverse()) await release(); };
  } catch (e) { for (const release of held.reverse()) await release(); throw e; }
}

/** Preview by default. Checked worktrees retain their local Git branches,
 * including unmerged commits; existing user directories are never removed. */
export async function cleanManagedWorkspaces(project: string, apply = false, options: CleanupOptions = {}): Promise<CleanupResult[]> {
  const execute = async () => {
    await archiveInactiveWorkspaces(project, options);
    await discoverBuildCaches();
    return cleanRegistered(project, apply, options);
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
