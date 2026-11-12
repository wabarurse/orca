import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { ensureProject } from "../agent-loop/orc/orchestrator";
import { ensureWorktree } from "./runner";
import { registerTask } from "../data/tasks";
import { ask } from "../data/inbox/questions";
import { directories, workspaces } from "../data/projects";
import { deleteFolder, deleteProject, describeDeletion, folderNode, projectNode } from "./ownership";

let root: string, repo: string, previous: string | undefined;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const quiet = { live: async () => [] as string[], stop: async () => {}, kill: async () => {} };
const folderOf = async (project: string) => (await directories.directoryProjects()).find(f => f.conversations.includes(project))!;

beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  root = realpathSync(mkdtempSync(join(tmpdir(), "orca-ownership-")));
  process.env.ORCA_HOME = join(root, "state");
  repo = join(root, "source"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "fixture");
  await ensureProject("p", repo);
  await ensureProject("q", repo);
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

test("the tree reads folder → projects → sessions → items, and says what a deletion loses", async () => {
  const clean = await ensureWorktree("p", "task/clean");
  const dirty = await ensureWorktree("p", "task/dirty");
  mkdirSync(join(clean, "node_modules")); writeFileSync(join(clean, "node_modules/fixture"), "generated");
  writeFileSync(join(dirty, "draft"), "only copy");
  const task = await workspaces.within("p", dirty, () => registerTask("p", { name: "Dirty", summary: "Work", branch: "task/dirty", authorized: true }));
  const [question] = await ask("p", [{ text: "Which one?" }]);

  const folder = await folderNode((await folderOf("p")).id);
  expect(folder.directory).toBe(repo);
  expect(folder.projects.map(p => p.id).sort()).toEqual(["p", "q"]);
  const p = folder.projects.find(node => node.id === "p")!;
  const main = p.sessions.find(s => !s.worktree)!;
  expect(main.path).toBe(repo);
  expect(main.items.question).toEqual([question!.id]);
  const worktrees = p.sessions.filter(s => s.worktree);
  expect(worktrees.map(s => s.path).sort()).toEqual([clean, dirty].sort());
  // Build output can be regenerated; an untracked source file cannot.
  expect(worktrees.find(s => s.path === clean)!.uncommitted).toBeUndefined();
  expect(worktrees.find(s => s.path === dirty)!.uncommitted).toContain("untracked");
  expect(worktrees.find(s => s.path === dirty)!.items.task).toEqual([task.id]);
  expect(folder.projects.find(node => node.id === "q")!.sessions.filter(s => s.worktree)).toEqual([]);

  expect(describeDeletion([p])).toBe("2 worktrees, 1 with uncommitted files that will be lost");
  expect(describeDeletion(folder.projects)).toBe("2 conversations, 2 worktrees, 1 with uncommitted files that will be lost");
  expect(describeDeletion([await projectNode("q")])).toBe("");
});

test("deleting a project removes its worktrees and every record under it, and nothing of its sibling", async () => {
  const mine = await ensureWorktree("p", "task/mine");
  const theirs = await ensureWorktree("q", "task/theirs");
  writeFileSync(join(mine, "draft"), "uncommitted");
  mkdirSync(join(mine, "node_modules")); writeFileSync(join(mine, "node_modules/fixture"), "generated");
  await registerTask("p", { name: "Mine", summary: "Work", branch: "task/mine", authorized: true });
  await ask("p", [{ text: "Mine?" }]);
  const kept = await ask("q", [{ text: "Theirs?" }]);
  const namespace = paths.worktrees("p"), folder = await folderOf("p");

  // Uncommitted files refuse the deletion until the caller says to discard them.
  await expect(deleteProject("p", quiet)).rejects.toThrow("local files or changes");
  expect(existsSync(mine)).toBe(true); expect(existsSync(paths.project("p"))).toBe(true);

  await deleteProject("p", { ...quiet, discard: true });
  expect(existsSync(mine)).toBe(false); expect(existsSync(namespace)).toBe(false);
  expect(existsSync(paths.project("p"))).toBe(false); expect(existsSync(paths.runtimeProject("p"))).toBe(false);
  expect(git(repo, "branch", "--list", "task/mine")).toContain("task/mine"); // Commits stay on the branch.
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("task-mine");
  // No ownership record names the deleted project; the shared folder session keeps its other member.
  expect(workspaces.resources().filter(r => r.project === "p")).toEqual([]);
  expect(workspaces.list().flatMap(w => w.members.map(m => m.project)).includes("p")).toBe(false);
  expect(workspaces.list().some(w => w.path === repo && w.members.some(m => m.project === "q"))).toBe(true);
  expect((await directories.directoryProjects()).find(f => f.id === folder.id)!.conversations).toEqual(["q"]);
  // The sibling keeps its worktree, its items and the repository.
  expect(existsSync(theirs)).toBe(true);
  expect(workspaces.resource("q", "question", kept[0]!.id)).toBeTruthy();
  expect(existsSync(join(repo, ".git"))).toBe(true);
});

test("deleting a folder deletes every project in it, or none; the directory itself is kept", async () => {
  const a = await ensureWorktree("p", "task/a"), b = await ensureWorktree("q", "task/b");
  writeFileSync(join(repo, "notes"), "the user's own file");
  const folder = await folderOf("p");

  // One project with a live agent leaves both in place.
  const live = async (project: string) => project === "q" ? ["worker-task-b"] : [];
  await expect(deleteFolder(folder.id, { ...quiet, live })).rejects.toThrow("still has live agents");
  expect(existsSync(a)).toBe(true); expect(existsSync(paths.project("p"))).toBe(true); expect(existsSync(paths.project("q"))).toBe(true);

  const removed: string[] = [];
  await deleteFolder(folder.id, { ...quiet, beforeRemove: project => { removed.push(project); } });
  expect(removed.sort()).toEqual(["p", "q"]);
  expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(false);
  expect(existsSync(paths.project("p"))).toBe(false); expect(existsSync(paths.project("q"))).toBe(false);
  expect((await directories.directoryProjects()).some(f => f.id === folder.id)).toBe(false);
  expect(workspaces.list()).toEqual([]); expect(workspaces.resources()).toEqual([]);
  expect(Bun.file(join(repo, "notes")).size).toBeGreaterThan(0);
  expect(git(repo, "branch", "--list", "task/*").split("\n")).toHaveLength(2);
});
