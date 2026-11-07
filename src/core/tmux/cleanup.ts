import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, repositoryBinding } from "../../config";
import { assertWorktree } from "../data/projects";
import { existingTasks } from "../data/tasks";
import { listProcesses, liveProcess } from "../data/processes";
import { withStorageLock } from "../data";
import { run } from "../proc";
import { agentActivity } from "./activity";
import { sessionId, slug } from "./runner";

const generated = /^(?:node_modules|dist|build|coverage|\.venv|\.next|\.turbo|\.pytest_cache|\.mypy_cache|\.ruff_cache|__pycache__|bazel-[^/]+)(?:\/|$)|\/__pycache__\//;
/** Remove generated checkout storage only after the task merged and all owners exited.
 * The same branch lock is held by spawn, so a new assignment cannot race disposal. */
export async function cleanManagedWorkspaces(project: string, apply = false) {
  const result: { path: string; disposition: string }[] = [];
  if (!repositoryBinding(project)) return result;
  const tasks = existingTasks(project);
  for (const task of tasks.filter(t => t.archive && !tasks.some(other => other.branch === t.branch && !other.archive))) {
    const path = paths.worktree(project, slug(task.branch));
    if (!existsSync(path)) continue;
    await withStorageLock(join(paths.runtimeProject(project), "spawn-locks", sessionId("worker", task.branch)), async () => {
      const keep = (reason: string) => result.push({ path, disposition: reason });
      try { await assertWorktree(project, path, task.branch); }
      catch { keep("kept: checkout ownership cannot be verified"); return; }
      const snapshot = await agentActivity(project);
      if (!snapshot.inventoryComplete) { keep("kept: agent inventory unavailable"); return; }
      const rows = snapshot.agents.filter(a => a.record?.branch === task.branch || a.agent === sessionId("worker", task.branch) || a.agent === sessionId("reviewer", task.branch));
      if (!rows.length || rows.some(a => a.status !== "exited" || a.queuedMessages !== 0)) { keep("kept: agent activity or queued work"); return; }
      if ((await listProcesses(project)).some(p => p.branch === task.branch && (liveProcess(p) || p.state === "unknown"))) { keep("kept: background command"); return; }
      const git = (args: string[]) => run(["git", ...args], { cwd: path, timeoutMs: 10_000 });
      const head = await git(["rev-parse", "HEAD"]);
      if (head?.code !== 0 || head.out.trim() !== task.pr?.head) { keep("kept: checkout differs from merged PR head"); return; }
      const status = await git(["status", "--porcelain", "--untracked-files=all"]);
      if (status?.code !== 0 || status.out.trim()) { keep("kept: source edits or untracked files"); return; }
      const ignored = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
      if (ignored?.code !== 0 || ignored.out.split("\0").filter(Boolean).some(file => !generated.test(file))) { keep("kept: unrecognized ignored files"); return; }
      const uid = process.getuid?.();
      const open = uid === undefined ? null : await run(["lsof", "-nP", "-a", "-u", String(uid), "-d", "cwd,txt", "-Fn"], { cwd: paths.repo(project), timeoutMs: 10_000 });
      if (!open || open.code !== 0 || open.err.trim()) { keep("kept: local process inspection unavailable"); return; }
      if (open.out.split("\n").some(line => line === `n${path}` || line.startsWith(`n${path}/`))) { keep("kept: local app uses checkout"); return; }
      if (!apply) { keep("eligible: merged checkout with generated files only"); return; }
      const removed = await run(["git", "worktree", "remove", "--force", "--", path], { cwd: paths.repo(project), timeoutMs: 60_000 });
      keep(removed?.code === 0 ? "removed" : "kept: git could not remove checkout");
    });
  }
  return result;
}
