import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { ensureProject } from "../agent-loop/orc/orchestrator";
import { ensureWorktree } from "./runner";
import { registerTask, observeTaskPR } from "../data/tasks";
import { cleanManagedWorkspaces } from "./cleanup";
import { archiveInactiveWorkspaces } from "./cleanup";
import { workspaces } from "../data/projects";
import { allTasks, restoreTask, setTaskDependencies, updateTaskMetadata } from "../data/tasks";
import { ask } from "../data/inbox/questions";
import { workArchive } from "../data/projects/work-archive";
import { discoverBuildCaches } from "./workspace-caches";
import { updateContext, workingContext, remember, facts } from "../data/knowledge";
let root: string, repo: string, worktree: string, previous: string | undefined;
const later = () => ({ now: Date.now() + 15 * 86400_000, openPaths: async () => [] as string[], cacheRoots: [] as string[] });
const row = (rows: Awaited<ReturnType<typeof cleanManagedWorkspaces>>) => rows.find(r => r.path === worktree)!;
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
test("preview is read-only; explicit clean removes archived resources and keeps the original checkout and branch", async () => {
  mkdirSync(join(worktree, "node_modules")); writeFileSync(join(worktree, "node_modules/fixture"), "generated");
  const before = JSON.stringify(workspaces.list());
  const resources = JSON.stringify(workspaces.resources());
  const files = readdirSync(paths.root, { recursive: true }).sort();
  const preview = await cleanManagedWorkspaces("p", false, later());
  expect(row(preview).disposition).toStartWith("eligible:");
  expect(JSON.stringify(workspaces.list())).toBe(before);
  expect(JSON.stringify(workspaces.resources())).toBe(resources);
  expect(readdirSync(paths.root, { recursive: true }).sort()).toEqual(files);
  expect(existsSync(worktree)).toBe(true);
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toBe("removed archived session");
  expect(existsSync(worktree)).toBe(false); expect(existsSync(join(repo, ".git"))).toBe(true);
  expect(git(repo, "rev-parse", "refs/heads/task/fix")).toBeTruthy();
  expect(await allTasks("p")).toHaveLength(0);
  expect(existsSync(paths.transcript("p", "worker-task-fix") + ".launch")).toBe(false);
  const next = await registerTask("p", { name: "Next", summary: "New work", branch: "next", authorized: true });
  expect(next.number).toBe(2);
  const db = new Database(paths.memory);
  try { expect(() => db.exec("DELETE FROM task_ledger_records")).toThrow(); }
  finally { db.close(); }
});
test("cleanup preserves untracked source, unexpected ignored files and queued instructions", async () => {
  writeFileSync(join(worktree, "draft"), "untracked source");
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toContain("source edits");
  rmSync(join(worktree, "draft")); writeFileSync(join(worktree, ".env"), "local settings");
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toContain("unrecognized ignored");
  rmSync(join(worktree, ".env")); mkdirSync(join(paths.inbox("p"), "worker-task-fix"), { recursive: true });
  writeFileSync(join(paths.inbox("p"), "worker-task-fix", "pending.json"), "{}");
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toContain("queued work");
  expect(existsSync(worktree)).toBe(true);
});

test("maintenance archives all linked page items after 14 days without deleting or changing task state", async () => {
  const [q] = await workspaces.within("p", worktree, () => ask("p", [{ text: "Old question" }]));
  const image = crypto.randomUUID();
  workspaces.own("p", "image", image, { directory: worktree });
  await archiveInactiveWorkspaces("p", { now: Date.now() + 13 * 86400_000, openPaths: later().openPaths });
  expect((await allTasks("p"))[0]!.removedAt).toBeUndefined();
  await archiveInactiveWorkspaces("p", later());
  expect(existsSync(worktree)).toBe(true);
  const [task] = await allTasks("p");
  expect(task?.removedAt).toBeTruthy();
  expect(workArchive("p", "questions")[q!.id]).toBe(true);
  expect(workArchive("p", "images")[image]).toBe(true);
  expect(workspaces.archived("p", "agent", "worker-task-fix")).toBeTruthy();
  const state = task!.status;
  await restoreTask("p", task!.id);
  expect((await allTasks("p"))[0]!.removedAt).toBeUndefined();
  expect((await allTasks("p"))[0]!.status).toBe(state);
  expect(workArchive("p", "questions")[q!.id]).toBeUndefined();
  expect(workspaces.archived("p", "image", image)).toBeUndefined();
});

test("untracked tasks are unnecessary; new work and open processes prevent expiration", async () => {
  const path = await ensureWorktree("p", "exploration/no-task");
  const opts = later();
  expect((await cleanManagedWorkspaces("p", false, opts)).find(r => r.path === path)?.disposition).toStartWith("eligible:");
  expect((await cleanManagedWorkspaces("p", false, { ...opts, openPaths: async () => [join(path, "app")] })).find(r => r.path === path)?.disposition).toContain("process uses");
  workspaces.ensure("p", path, { at: new Date(opts.now).toISOString() });
  expect((await cleanManagedWorkspaces("p", true, opts)).find(r => r.path === path)?.disposition).toContain("not archived");
  expect(existsSync(path)).toBe(true);
});

test("source edits and private ignored files survive while nested generated build files are reclaimed", async () => {
  writeFileSync(join(worktree, "draft"), "keep source");
  writeFileSync(join(worktree, ".env"), "keep private settings");
  mkdirSync(join(worktree, "apps/web/node_modules"), { recursive: true });
  writeFileSync(join(worktree, "apps/web/node_modules", "large"), "generated");
  const result = row(await cleanManagedWorkspaces("p", true, later()));
  expect(result.disposition).toContain("source edits");
  expect(existsSync(join(worktree, "draft"))).toBe(true);
  expect(existsSync(join(worktree, ".env"))).toBe(true);
  expect(existsSync(join(worktree, "apps/web/node_modules"))).toBe(false);
});

test("shared images survive deleting one session; questions and private artifacts are purged", async () => {
  const image = crypto.randomUUID(), imagePath = join(paths.project("p"), "images", `${image}.png`);
  mkdirSync(dirname(imagePath), { recursive: true }); writeFileSync(imagePath, "fixture bytes");
  workspaces.own("p", "image", image, { directory: repo, path: imagePath });
  workspaces.own("p", "image", image, { directory: worktree, path: imagePath });
  const [q] = await workspaces.within("p", worktree, () => ask("p", [{ text: "Task-specific question" }]));
  const artifact = join(paths.project("p"), "tool-outputs", "video.mp4");
  mkdirSync(dirname(artifact), { recursive: true }); writeFileSync(artifact, "video");
  workspaces.own("p", "artifact", artifact, { directory: worktree, path: artifact });
  const options = later();
  workspaces.ensure("p", repo, { at: new Date(options.now).toISOString() });
  expect(row(await cleanManagedWorkspaces("p", true, options)).disposition).toBe("removed archived session");
  expect(existsSync(imagePath)).toBe(true);
  expect(existsSync(join(paths.questions("p"), `${q!.id}.json`))).toBe(false);
  expect(existsSync(artifact)).toBe(false);
});

test("stable IDs survive moves; a new directory at an old path cannot inherit deletion authority", async () => {
  const old = workspaces.list().find(w => w.path === worktree)!;
  const moved = worktree + "-moved";
  git(repo, "worktree", "move", worktree, moved);
  expect(workspaces.ensure("p", moved).id).toBe(old.id);
  mkdirSync(worktree); writeFileSync(join(worktree, "keep"), "different directory");
  const replacement = workspaces.ensure("p", worktree);
  expect(replacement.id).not.toBe(old.id);
  expect(replacement.disposable).toBe(false);
  expect(workspaces.get(old.id)?.path).toBe(moved);
});

test("an interrupted cleanup blocks admissions and is retryable without restarting work", async () => {
  await archiveInactiveWorkspaces("p", later());
  const w = workspaces.list().find(w => w.path === worktree)!;
  workspaces.claim(w.id, w.lastActivityAt);
  expect(() => workspaces.own("p", "agent", "worker-task-fix", { directory: worktree })).toThrow("cleanup");
  const task = (await allTasks("p"))[0]!;
  await expect(updateTaskMetadata("p", task.id, { title: "Must not commit" })).rejects.toThrow("cleanup");
  expect((await allTasks("p"))[0]!.name).toBe(task.name);
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toBe("removed archived session");
});

test("external build caches require exact workspace identity; shared downloads are untouched", async () => {
  const caches = join(root, "build-caches"), cache = join(caches, "a".repeat(32)), shared = join(caches, "cache");
  mkdirSync(cache, { recursive: true }); mkdirSync(shared);
  writeFileSync(join(cache, "DO_NOT_BUILD_HERE"), worktree + "\n");
  writeFileSync(join(cache, "compiled"), "generated");
  await discoverBuildCaches([caches]);
  expect(workspaces.resource("p", "cache", cache)).toBeTruthy();
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toBe("removed archived session");
  expect(existsSync(cache)).toBe(false);
  expect(existsSync(shared)).toBe(true);
});

for (const replacement of [false, true]) test(`a ${replacement ? "recreated" : "deleted"} cache owner cannot block another session or inherit its cache`, async () => {
  await ensureProject("gone", repo);
  const shared = workspaces.ensure("p", repo);
  workspaces.ensure("gone", repo);
  const caches = join(root, "build-caches"), stale = join(caches, "a".repeat(32)), valid = join(caches, "b".repeat(32));
  for (const [path, source] of [[stale, repo], [valid, worktree]] as const) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "DO_NOT_BUILD_HERE"), source);
    writeFileSync(join(path, "compiled"), "generated");
  }
  rmSync(paths.project("gone"), { recursive: true });
  if (replacement) await ensureProject("gone", repo);
  const before = JSON.stringify(workspaces.resources()), sessions = JSON.stringify(workspaces.list());
  const options = { ...later(), cacheRoots: [caches] };
  const preview = await cleanManagedWorkspaces("p", false, options);
  expect(preview.find(r => r.path === stale)?.disposition).toContain("owner gone was removed or changed identity");
  expect(preview.find(r => r.session === shared.id && r.path === repo)?.disposition).toContain("identity changed or was removed");
  expect(row(preview).disposition).toStartWith("eligible:");
  expect(JSON.stringify(workspaces.resources())).toBe(before);
  expect(JSON.stringify(workspaces.list())).toBe(sessions);
  expect(existsSync(valid)).toBe(true);
  const cleaned = await cleanManagedWorkspaces("p", true, options);
  expect(row(cleaned).disposition).toBe("removed archived session");
  expect(existsSync(valid)).toBe(false);
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(repo)).toBe(true);
  if (replacement) expect(workspaces.resource("gone", "cache", stale)).toBeUndefined();
});

test("one broken cache path is reported without blocking another session's cleanup", async () => {
  const caches = join(root, "build-caches"), stale = join(caches, "a".repeat(32));
  mkdirSync(caches); symlinkSync(join(root, "missing"), stale);
  const options = { ...later(), cacheRoots: [caches] };
  const result = await cleanManagedWorkspaces("p", true, options);
  expect(result.find(r => r.path === stale)?.disposition).toContain("build cache inspection failed");
  expect(row(result).disposition).toBe("removed archived session");
  expect(lstatSync(stale).isSymbolicLink()).toBe(true);
});

test("an unreadable registered cache blocks its owner while another worktree is cleaned", async () => {
  const other = await ensureWorktree("p", "other-task");
  const cache = join(root, "broken-cache"); mkdirSync(cache);
  writeFileSync(join(cache, "DO_NOT_BUILD_HERE"), worktree);
  workspaces.own("p", "cache", cache, { directory: worktree, path: cache });
  rmSync(join(cache, "DO_NOT_BUILD_HERE"));
  mkdirSync(join(cache, "DO_NOT_BUILD_HERE"));
  const result = await cleanManagedWorkspaces("p", true, later());
  expect(row(result).disposition).toContain("inspection failed");
  expect(result.find(r => r.path === other)?.disposition).toBe("removed archived session");
  expect(existsSync(worktree)).toBe(true);
  expect(existsSync(cache)).toBe(true);
});

test("retained dependency edges protect task records", async () => {
  const [original] = await allTasks("p");
  const other = await registerTask("p", { name: "Dependent", summary: "Keep dependency", branch: "different", authorized: true });
  await setTaskDependencies("p", other.id, [original!.id]);
  const options = later();
  workspaces.ensure("p", repo, { at: new Date(options.now).toISOString() });
  expect(row(await cleanManagedWorkspaces("p", true, options)).disposition).toContain("retained dependencies");
  expect((await allTasks("p")).find(t => t.id === original!.id)).toBeTruthy();
});

test("source and build files survive if a process appears during cleanup inspection", async () => {
  writeFileSync(join(worktree, "draft"), "source");
  mkdirSync(join(worktree, "node_modules")); writeFileSync(join(worktree, "node_modules/build"), "generated");
  const options = later();
  workspaces.ensure("p", repo, { at: new Date(options.now).toISOString() });
  let inspected = 0;
  const result = row(await cleanManagedWorkspaces("p", true, { ...options, openPaths: async () => ++inspected >= 3 ? [worktree] : [] }));
  expect(result.disposition).toContain("local process uses");
  expect(existsSync(join(worktree, "node_modules/build"))).toBe(true);
});

test("a redirected checkout cannot delete another directory", async () => {
  await archiveInactiveWorkspaces("p", later());
  const preserved = worktree + "-preserved";
  renameSync(worktree, preserved);
  const elsewhere = join(root, "unrelated"); mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep"), "user data");
  symlinkSync(elsewhere, worktree);
  expect(row(await cleanManagedWorkspaces("p", true, later())).disposition).toContain("symlink");
  expect(existsSync(join(elsewhere, "keep"))).toBe(true);
  expect(existsSync(preserved)).toBe(true);
});

test("ordinary directories share activity across conversations and retain user files", async () => {
  const directory = join(root, "notes"); mkdirSync(directory); writeFileSync(join(directory, "keep.md"), "user notes");
  await ensureProject("notes-a", directory); await ensureProject("notes-b", directory);
  await updateContext("notes-a", { goal: "Old session work" });
  await remember("notes-a", "project", { key: "style", text: "Keep responses short", source: "user", confidence: "explicit", updatedAt: new Date().toISOString(), project: "notes-a" });
  const a = workspaces.ensure("notes-a", directory), b = workspaces.ensure("notes-b", directory);
  expect(a.id).toBe(b.id);
  const [q] = await workspaces.within("notes-a", directory, () => ask("notes-a", [{ text: "Old question" }]));
  const options = later();
  workspaces.ensure("notes-b", directory, { at: new Date(options.now).toISOString() });
  await archiveInactiveWorkspaces("notes-a", options);
  expect(workspaces.get(a.id)?.archivedAt).toBeUndefined();
  options.now += 15 * 86400_000;
  await archiveInactiveWorkspaces("notes-a", options);
  expect(workArchive("notes-a", "questions")[q!.id]).toBe(true);
  expect((await cleanManagedWorkspaces("notes-a", true, options))[0]?.disposition).toBe("removed archived session");
  expect(existsSync(join(directory, "keep.md"))).toBe(true);
  expect(existsSync(join(paths.questions("notes-a"), `${q!.id}.json`))).toBe(false);
  expect((await workingContext("notes-a")).goal).toBeUndefined();
  expect((await facts("notes-a", "project"))[0]!.text).toBe("Keep responses short");
});
