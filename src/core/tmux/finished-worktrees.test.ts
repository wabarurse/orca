import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths, repositoryBinding } from "../../config";
import { ensureProject } from "../agent-loop/orc/orchestrator";
import { ensureWorktree } from "./runner";
import { allTasks, observeTaskPR, registerTask, restoreTask } from "../data/tasks";
import { FINISHED_GRACE_MS, removeFinishedWorktrees } from "./cleanup";
import { workspaces } from "../data/projects";

let root: string, repo: string, previous: string | undefined;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const after = (ms = FINISHED_GRACE_MS + 60_000) => ({ now: Date.now() + ms, openPaths: async () => [] as string[] });
const exited = (branch: string) => {
  const id = `worker-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  mkdirSync(paths.runs("p"), { recursive: true });
  writeFileSync(join(paths.runs("p"), `${id}.json`), JSON.stringify({ run: "done", pid: 2 ** 30, role: "worker", branch, state: "reported", endedAt: new Date().toISOString(), step: "done", tool: "", ts: new Date().toISOString() }));
  mkdirSync(join(paths.project("p"), "transcript"), { recursive: true });
  writeFileSync(`${paths.transcript("p", id)}.launch`, "done");
  return id;
};
async function task(branch: string, state?: "OPEN" | "MERGED" | "CLOSED") {
  const worktree = await ensureWorktree("p", branch);
  const t = await registerTask("p", { name: branch, summary: "Work", branch, authorized: true });
  const pr = { repository: "o/r", number: 1, head: git(worktree, "rev-parse", "HEAD"), url: "https://github.com/o/r/pull/1" };
  if (state) await observeTaskPR("p", t.id, { pr, branch, state: "OPEN", checks: "unknown", ready: false });
  if (state === "MERGED") await observeTaskPR("p", t.id, { pr, branch, state, mergedAt: new Date().toISOString(), checks: "unknown", ready: false });
  if (state === "CLOSED") await observeTaskPR("p", t.id, { pr, branch, state, checks: "unknown", ready: false });
  exited(branch);
  return { worktree, id: t.id };
}
const commit = (cwd: string, file: string) => { writeFileSync(join(cwd, file), file); git(cwd, "add", "."); git(cwd, "commit", "-qm", file); };

beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  root = realpathSync(mkdtempSync(join(tmpdir(), "orca-finished-worktrees-")));
  process.env.ORCA_HOME = join(root, "state");
  repo = join(root, "source"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  await ensureProject("p", repo);
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

test("worktrees are created in the home, one folder per repository and conversation", async () => {
  const worktree = await ensureWorktree("p", "task/fix");
  expect(worktree).toBe(join(root, "state", "worktrees", `source--${repositoryBinding("p")!.worktreeId.slice(0, 8)}`, "task-fix"));
  expect(existsSync(`${repo}.orca-worktrees`)).toBe(false);
  await ensureProject("q", repo);
  expect(paths.worktrees("q")).not.toBe(paths.worktrees("p"));
});

test("a merged PR gives its checkout back after the grace period; branch, task and transcript stay, and the session is archived", async () => {
  const { worktree, id } = await task("task/fix", "MERGED");
  commit(worktree, "late"); // Committed after the merge: kept on the branch.
  mkdirSync(join(worktree, "node_modules")); writeFileSync(join(worktree, "node_modules/fixture"), "generated");
  const head = git(worktree, "rev-parse", "HEAD");
  expect(await removeFinishedWorktrees("p", after(0))).toEqual([]);
  expect(existsSync(worktree)).toBe(true);
  const [row] = await removeFinishedWorktrees("p", after());
  expect(row!.disposition).toBe("removed worktree: its PR merged; branch task/fix kept");
  expect(row!.bytes).toBeGreaterThan(0);
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, "rev-parse", "refs/heads/task/fix")).toBe(head);
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("task-fix");
  expect(existsSync(`${paths.transcript("p", "worker-task-fix")}.launch`)).toBe(true);
  const [saved] = await allTasks("p");
  expect(saved!.id).toBe(id); expect(saved!.archive).toBeTruthy(); expect(saved!.removedAt).toBeTruthy();
  expect(workspaces.archived("p", "agent", "worker-task-fix")).toBeTruthy();
  // Restoring the task and spawning again recreates the checkout on the kept branch.
  await restoreTask("p", id);
  expect(await ensureWorktree("p", "task/fix")).toBe(worktree);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
});

test("a closed PR counts as finished; an open one, local edits, private ignored files and queued input do not", async () => {
  const open = await task("task/open", "OPEN");
  commit(open.worktree, "work");
  expect(await removeFinishedWorktrees("p", after())).toEqual([]);
  expect(existsSync(open.worktree)).toBe(true);

  const closed = await task("task/closed", "CLOSED");
  const kept = async () => (await removeFinishedWorktrees("p", after())).find(r => r.path === closed.worktree)!.disposition;
  writeFileSync(join(closed.worktree, "draft"), "untracked source");
  expect(await kept()).toContain("source edits");
  rmSync(join(closed.worktree, "draft")); writeFileSync(join(closed.worktree, ".env"), "local settings");
  expect(await kept()).toContain("unrecognized ignored");
  rmSync(join(closed.worktree, ".env")); mkdirSync(join(paths.inbox("p"), "worker-task-closed"), { recursive: true });
  writeFileSync(join(paths.inbox("p"), "worker-task-closed", "pending.json"), "{}");
  expect(await kept()).toContain("queued work");
  expect(existsSync(closed.worktree)).toBe(true);
  rmSync(join(paths.inbox("p"), "worker-task-closed"), { recursive: true });
  expect(await kept()).toBe("removed worktree: its task is closed; branch task/closed kept");
  expect(existsSync(open.worktree)).toBe(true);
});

test("without a PR, a branch must have moved and be merged into the default branch", async () => {
  const fresh = await ensureWorktree("p", "task/fresh"); exited("task/fresh");
  const local = await ensureWorktree("p", "task/local"); exited("task/local");
  const t = await registerTask("p", { name: "Local", summary: "Work", branch: "task/local", authorized: true });
  commit(local, "feature");
  // Nothing committed proves nothing; committed but unmerged work is still in progress.
  expect(await removeFinishedWorktrees("p", after())).toEqual([]);
  git(repo, "merge", "-q", "--ff-only", "task/local");
  const rows = await removeFinishedWorktrees("p", after());
  expect(rows.map(r => r.disposition)).toEqual(["removed worktree: its branch is merged into main; branch task/local kept"]);
  expect(existsSync(local)).toBe(false); expect(existsSync(fresh)).toBe(true);
  // Its task was never settled, so it stays on the active list.
  expect((await allTasks("p")).find(row => row.id === t.id)!.removedAt).toBeUndefined();
});

test("a worktree an older build made beside the checkout is still found, and its emptied folder goes with it", async () => {
  const sibling = `${repo}.orca-worktrees`, namespace = join(sibling, repositoryBinding("p")!.worktreeId);
  git(repo, "worktree", "add", "-q", "-b", "task/old", join(namespace, "task-old"));
  expect(paths.worktree("p", "task-old")).toBe(join(namespace, "task-old"));
  expect(await ensureWorktree("p", "task/old")).toBe(join(namespace, "task-old"));
  exited("task/old");
  commit(join(namespace, "task-old"), "old");
  git(repo, "merge", "-q", "--ff-only", "task/old");
  expect((await removeFinishedWorktrees("p", after())).map(r => r.disposition)).toEqual(["removed worktree: its branch is merged into main; branch task/old kept"]);
  expect(existsSync(sibling)).toBe(false);
  // The next worktree for this conversation is created in the home.
  expect(await ensureWorktree("p", "task/next")).toStartWith(join(root, "state", "worktrees"));
});
