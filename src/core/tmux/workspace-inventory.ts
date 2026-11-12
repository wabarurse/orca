import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { paths, repositoryBinding } from "../../config";
import { workspaces } from "../data/projects";
import { existingTasks } from "../data/tasks";
import { listProcesses, listVerifications, verificationPaths } from "../data/processes";
import { questions } from "../data/inbox";
import { run } from "../proc";
import { agentActivity } from "./activity";
import { slug } from "./runner";

const names = (path: string) => readdir(path).catch(e => { if (e.code === "ENOENT") return []; throw e; });
const latest = (times: (string | undefined)[], fallback: string) => times.filter((s): s is string => !!s && Number.isFinite(Date.parse(s))).sort().at(-1) ?? fallback;
async function transcriptTime(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!await file.exists()) return;
  const tail = await file.slice(Math.max(0, file.size - 65536)).text();
  for (const line of tail.trim().split("\n").reverse()) {
    try { const entry = JSON.parse(line); if (typeof entry.ts === "string") return entry.ts; } catch { /* partial first line */ }
  }
}

/** Adopt only exact managed Git worktrees and existing Orca state. Unknown-age
 * directories get a fresh 14-day grace period. Discovery is not activity. */
export async function discoverWorkspaces(project: string, now = Date.now()): Promise<void> {
  const repo = paths.repo(project);
  if (!existsSync(repo)) return;
  const at = new Date(now).toISOString(), previous = workspaces.list();
  const fallback = (path: string) => previous.find(w => w.path === path && !w.cleanedAt)?.lastActivityAt ?? at;
  const activity = await agentActivity(project), tasks = existingTasks(project), processes = await listProcesses(project);
  const sandboxes = await listVerifications(project), asked = await questions.all(project);
  // Legacy conversation-wide artifacts may have been written by any worker.
  // Retain their owning conversation until all its recorded activity is old.
  const root = workspaces.ensure(project, repo, { at: latest([await transcriptTime(paths.transcript(project, "orchestrator")),
    ...tasks.map(t => t.updatedAt), ...activity.agents.map(a => a.record?.endedAt ?? a.record?.ts),
    ...processes.map(p => p.updatedAt), ...sandboxes.map(v => v.createdAt), ...asked.map(q => q.ts)], fallback(realpathSync(repo))) });
  const byPath = new Map<string, workspaces.Workspace>([[root.path, root]]);
  if (repositoryBinding(project)?.branch !== "") {
    const git = await run(["git", "worktree", "list", "--porcelain", "-z"], { cwd: repo, timeoutMs: 10_000 });
    if (!git || git.code !== 0) throw new Error("cannot discover managed worktrees");
    const managed = paths.worktreeRoots(project).map(root => root + sep);
    for (const record of git.out.split("\0\0")) {
      const fields = record.split("\0"), path = fields.find(f => f.startsWith("worktree "))?.slice(9);
      const branch = fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18);
      if (!path || !managed.some(root => path.startsWith(root)) || !branch || !existsSync(path)) continue;
      const canonical = realpathSync(path);
      if (canonical !== path) continue; // A redirect is not owned scratch.
      const times = [...tasks.filter(t => t.branch === branch).map(t => t.updatedAt),
        ...activity.agents.filter(a => a.record?.branch === branch).map(a => a.record?.endedAt ?? a.record?.ts),
        ...processes.filter(p => p.cwd === path).map(p => p.updatedAt)];
      byPath.set(path, workspaces.ensure(project, path, { disposable: true, repo, branch, at: latest(times, fallback(path)) }));
    }
  }
  const owner = (directory: string | undefined, branch?: string) => byPath.get(directory ?? "") ?? byPath.get(branch ? paths.worktree(project, slug(branch)) : repo) ?? root;
  for (const agent of activity.agents) {
    const w = owner(agent.record?.cwd, agent.record?.branch);
    if (!workspaces.resource(project, "agent", agent.agent)) workspaces.own(project, "agent", agent.agent, { session: w });
  }
  workspaces.own(project, "agent", "orchestrator", { session: root, exclusive: true });
  for (const task of tasks) if (!workspaces.resource(project, "task", task.id)) workspaces.own(project, "task", task.id, { session: owner(undefined, task.branch) });
  for (const p of processes) if (!workspaces.resource(project, "process", p.id)) workspaces.own(project, "process", p.id, { session: owner(p.cwd, p.branch) });
  for (const v of sandboxes) if (!workspaces.resource(project, "sandbox", v.id)) {
    workspaces.own(project, "sandbox", v.id, { session: owner(v.source), path: verificationPaths(project, v.id).evidence });
  }
  for (const q of asked) if (!workspaces.resource(project, "question", q.id)) workspaces.own(project, "question", q.id, { session: root, path: join(paths.questions(project), `${q.id}.json`) });
  // Old images and arbitrary output folders have no trustworthy worker link.
  // Keep them with their conversation, never guess from filenames or prose.
  for (const name of await names(join(paths.project(project), "images"))) {
    const id = /^([a-f0-9-]{36})\.(png|jpg|gif|webp)$/.exec(name)?.[1];
    if (id && !workspaces.resource(project, "image", id)) workspaces.own(project, "image", id, { session: root, path: join(paths.project(project), "images", name) });
  }
  for (const name of await names(join(paths.project(project), "tool-outputs"))) {
    if (name === "verification" || name.endsWith(".running")) continue;
    const path = join(paths.project(project), "tool-outputs", name);
    if (!workspaces.resource(project, "artifact", path)) workspaces.own(project, "artifact", path, { session: root, path });
  }
}
