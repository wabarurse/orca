import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { ensureProject } from "../agent-loop/orc/orchestrator";
import { ensureWorktree } from "./runner";
import { registerTask, observeTaskPR } from "../data/tasks";
import { cleanManagedWorkspaces } from "./cleanup";
let root: string, repo: string, worktree: string, previous: string | undefined;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  root = realpathSync(mkdtempSync(join(tmpdir(), "orca-checkout-cleanup-")));
  process.env.ORCA_HOME = join(root, "state");
  repo = join(root, "source"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  await ensureProject("p", repo);
  worktree = await ensureWorktree("p", "task/fix");
  const t = await registerTask("p", { name: "Fixture", summary: "Work", branch: "task/fix", authorized: true });
  const pr = { repository: "o/r", number: 1, head: git(worktree, "rev-parse", "HEAD"), url: "https://github.com/o/r/pull/1" };
  await observeTaskPR("p", t.id, { pr, branch: "task/fix", state: "OPEN", checks: "unknown", ready: false });
  await observeTaskPR("p", t.id, { pr, branch: "task/fix", state: "MERGED", mergedAt: new Date().toISOString(), checks: "unknown", ready: false });
  mkdirSync(paths.runs("p"), { recursive: true });
  writeFileSync(join(paths.runs("p"), "worker-task-fix.json"), JSON.stringify({ run: "done", pid: 2 ** 30, role: "worker", branch: "task/fix", state: "reported", endedAt: new Date().toISOString(), step: "done", tool: "", ts: new Date().toISOString() }));
  mkdirSync(join(paths.project("p"), "transcript"), { recursive: true });
  writeFileSync(`${paths.transcript("p", "worker-task-fix")}.launch`, "done");
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});
test("cleanup preview retains merged checkouts; applying removes generated files and preserves the source checkout", async () => {
  mkdirSync(join(worktree, "node_modules")); writeFileSync(join(worktree, "node_modules/fixture"), "generated");
  const preview = await cleanManagedWorkspaces("p");
  expect(preview[0]?.disposition).toStartWith("eligible:");
  expect(existsSync(worktree)).toBe(true);
  expect((await cleanManagedWorkspaces("p", true))[0]?.disposition).toBe("removed");
  expect(existsSync(worktree)).toBe(false); expect(existsSync(join(repo, ".git"))).toBe(true);
});
test("cleanup preserves untracked source, unexpected ignored files and queued instructions", async () => {
  writeFileSync(join(worktree, "draft"), "untracked source");
  expect((await cleanManagedWorkspaces("p", true))[0]?.disposition).toContain("source edits");
  rmSync(join(worktree, "draft")); writeFileSync(join(worktree, ".env"), "local settings");
  expect((await cleanManagedWorkspaces("p", true))[0]?.disposition).toContain("unrecognized ignored");
  rmSync(join(worktree, ".env")); mkdirSync(join(paths.inbox("p"), "worker-task-fix"), { recursive: true });
  writeFileSync(join(paths.inbox("p"), "worker-task-fix", "pending.json"), "{}");
  expect((await cleanManagedWorkspaces("p", true))[0]?.disposition).toContain("queued work");
  expect(existsSync(worktree)).toBe(true);
});
