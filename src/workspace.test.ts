import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, repositoryBinding } from "./config";
import { ensureProject, createOrchestrator } from "./orchestrator";
import { ensureWorktree, removeWorktree } from "./runner";
import { deleteProject, listProjects, projectFor, repoHere } from "./commands";
import { projectTurnLock } from "./project-state";
import { tryStorageLock } from "./storage-lock";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { bash } from "./tools/bash";
import { mergeWatcher } from "./merges";

let temp: string, repo: string, previous: string | undefined;
const git = async (cwd: string, ...args: string[]) => {
  const result = await Bun.$`git -C ${cwd} ${args}`.quiet();
  return result.stdout.toString().trim();
};
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  temp = realpathSync(mkdtempSync(join(tmpdir(), "orca-workspace-")));
  process.env.ORCA_HOME = join(temp, "state");
  repo = join(temp, "original with spaces");
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(temp, { recursive: true, force: true });
});

test("original checkout, generic local login settings and untracked files remain available; reviewer shares worker worktree", async () => {
  await git(repo, "config", "buildbuddy.api-key", "fake-local-login");
  await git(repo, "config", "test.login", "another-fake-login");
  await Bun.write(join(repo, "local-only"), "local context");
  await ensureProject("p", repo);
  expect(paths.repo("p")).toBe(repo);
  expect(existsSync(join(paths.project("p"), "repo"))).toBe(false);
  const provider = fakeProvider([[toolUse("read", "bash", { command: "cat local-only; git config --local --get test.login" })], [text("done")]]);
  const orch = await createOrchestrator({ project: "p", provider, tools: { bash }, write: () => {} });
  await orch.say("check local context");
  await orch.turn();
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("local context");
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("another-fake-login");
  const worker = await ensureWorktree("p", "task/fix");
  expect(worker.startsWith(`${repo}.orca-worktrees/`)).toBe(true);
  expect(await git(worker, "config", "--local", "--get", "buildbuddy.api-key")).toBe("fake-local-login");
  await git(repo, "config", "test.login", "refreshed-login");
  expect(await git(worker, "config", "--local", "--get", "test.login")).toBe("refreshed-login");
  expect(await ensureWorktree("p", "task/fix")).toBe(worker);
  await Bun.write(join(worker, "worker-only"), "isolated");
  expect(existsSync(join(repo, "worker-only"))).toBe(false);
  expect(await git(repo, "branch", "--show-current")).toBe("main");
  orch.dispose?.();
});

test("discovery reuses exact checkout including symlinks, not another clone or a legacy project with the same origin", async () => {
  const origin = "https://example.invalid/org/repo.git";
  await git(repo, "remote", "add", "origin", origin);
  const legacy = join(paths.project("legacy"), "repo");
  await Bun.$`git init -q -b main ${legacy}`.quiet();
  await git(legacy, "remote", "add", "origin", origin);
  expect(await projectFor(repo)).toBeNull();
  await ensureProject("p", repo);
  const link = join(temp, "alias");
  symlinkSync(repo, link);
  expect(await repoHere(link)).toBe(repo);
  expect(await projectFor(link)).toBe("p");
  await ensureProject("p", link);
  const other = join(temp, "other");
  await Bun.$`git clone -q ${repo} ${other}`.quiet();
  await git(other, "remote", "set-url", "origin", origin);
  expect(await projectFor(other)).toBeNull();
  await expect(ensureProject("p", other)).rejects.toThrow("another checkout");
  await expect(ensureProject("legacy", repo)).rejects.toThrow("another checkout");
  await ensureProject("legacy");
  expect(paths.repo("legacy")).toBe(legacy);
});

test("main branch requirement never switches or stashes user work, including after project creation", async () => {
  await git(repo, "switch", "-c", "feature");
  await Bun.write(join(repo, "draft"), "keep me");
  await expect(ensureProject("p", repo)).rejects.toThrow("on main");
  expect(await git(repo, "branch", "--show-current")).toBe("feature");
  await git(repo, "switch", "main");
  await ensureProject("p", repo);
  await git(repo, "switch", "feature");
  const provider = fakeProvider([]);
  const orch = await createOrchestrator({ project: "p", provider, write: () => {} });
  await orch.say("do work");
  await expect(orch.turn()).rejects.toThrow("on main");
  expect(provider.calls).toHaveLength(0);
  expect(await orch.pending()).toBe(false);
  await git(repo, "switch", "main");
  expect(await orch.pending()).toBe(false); // A branch change alone does not retry queued work.
  await orch.say("resume");
  expect(await orch.pending()).toBe(true);
  expect(await Bun.file(join(repo, "draft")).text()).toBe("keep me");
  await expect(ensureWorktree("p", "main")).rejects.toThrow("task branch");
  orch.dispose?.();
});

test("parallel conversations serialize original-checkout turns and use separate worktree namespaces", async () => {
  await ensureProject("p", repo);
  await ensureProject("q", repo);
  expect(projectTurnLock("q")).toBe(projectTurnLock("p"));
  expect(paths.worktrees("q")).not.toBe(paths.worktrees("p"));
  const release = await tryStorageLock(projectTurnLock("p"));
  const provider = fakeProvider([]);
  const orch = await createOrchestrator({ project: "q", provider, write: () => {} });
  try {
    await orch.say("wait");
    expect(await orch.pending()).toBe(false);
    expect(await orch.turn()).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    await expect(deleteProject("q", { live: async () => [], kill: async () => {} })).rejects.toThrow("running");
  } finally { await release?.(); orch.dispose?.(); }
});

test("deletion refuses local worker files; clean deletion unregisters worktrees and preserves original files, login and branches", async () => {
  await ensureProject("p", repo);
  await git(repo, "config", "test.login", "keep-login");
  await Bun.write(join(repo, "draft"), "keep-original");
  const worker = await ensureWorktree("p", "task/fix");
  await Bun.write(join(worker, "draft"), "keep-worker");
  const opts = { live: async () => [], kill: async () => {} };
  await expect(deleteProject("p", { ...opts, live: async () => null })).rejects.toThrow("cannot check live agents");
  await expect(deleteProject("p", opts)).rejects.toThrow("local files or changes");
  expect(await Bun.file(join(worker, "draft")).text()).toBe("keep-worker");
  rmSync(join(worker, "draft"));
  await Bun.write(join(repo, ".git", "info", "exclude"), ".env\n");
  await Bun.write(join(worker, ".env"), "keep-local-login");
  await expect(deleteProject("p", opts)).rejects.toThrow("local files or changes");
  expect(await Bun.file(join(worker, ".env")).text()).toBe("keep-local-login");
  rmSync(join(worker, ".env"));
  await deleteProject("p", opts);
  expect(existsSync(paths.project("p"))).toBe(false);
  expect(existsSync(worker)).toBe(false);
  expect(await Bun.file(join(repo, "draft")).text()).toBe("keep-original");
  expect(await git(repo, "config", "--local", "--get", "test.login")).toBe("keep-login");
  expect(await git(repo, "branch", "--list", "task/fix")).toContain("task/fix");
  expect(await git(repo, "worktree", "list")).not.toContain(worker);
});

test("slug collisions and foreign directories cannot be reused or removed", async () => {
  await ensureProject("p", repo);
  await ensureWorktree("p", "task/fix");
  await expect(ensureWorktree("p", "task-fix")).rejects.toThrow("not on task-fix");
  await expect(removeWorktree("p", "task-fix")).rejects.toThrow("not on task-fix");
  const wrong = paths.worktree("p", "wrong");
  await Bun.$`git init -q ${wrong}`.quiet();
  await expect(ensureWorktree("p", "wrong")).rejects.toThrow("another checkout");
  await expect(removeWorktree("p", "wrong")).rejects.toThrow("another checkout");
  expect(existsSync(wrong)).toBe(true);
});

test("missing checkout stays discoverable; invalid metadata never silently creates a clone", async () => {
  await ensureProject("p", repo);
  renameSync(repo, `${repo}-moved`);
  expect(await listProjects()).toContain("p");
  await ensureProject("p");
  expect(paths.repo("p")).toBe(repo);
  await Bun.write(paths.repository("p"), "{}");
  expect(() => repositoryBinding("p")).toThrow("invalid repository binding");
  await expect(ensureProject("p")).rejects.toThrow("invalid repository binding");
});

test("new remote sources, nested state and worker checkouts are refused without cloning", async () => {
  await expect(ensureProject("remote", "https://example.invalid/repo.git")).rejects.toThrow("local git checkout");
  await expect(ensureProject("empty", temp)).rejects.toThrow("local git checkout");
  await ensureProject("p", repo);
  const worker = await ensureWorktree("p", "task/fix");
  await expect(ensureProject("nested", worker)).rejects.toThrow("original checkout");
  const managed = join(paths.root, "source");
  await Bun.$`git init -q -b main ${managed}`.quiet();
  await expect(ensureProject("managed", managed)).rejects.toThrow("separate directories");
});

test("origin default branch is honored and workers start there even if the user later switches HEAD", async () => {
  await git(repo, "branch", "-m", "trunk");
  const head = await git(repo, "rev-parse", "HEAD");
  await git(repo, "update-ref", "refs/remotes/origin/trunk", head);
  await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  await ensureProject("p", repo);
  expect(repositoryBinding("p")?.branch).toBe("trunk");
  await git(repo, "switch", "-c", "unrelated");
  await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "unrelated");
  const worker = await ensureWorktree("p", "task/fix");
  expect(await git(worker, "rev-parse", "HEAD")).toBe(head);
  expect(await git(repo, "branch", "--show-current")).toBe("unrelated");
});

test("merged worker cleanup does not pull or change the original checkout", async () => {
  const origin = join(temp, "origin.git");
  await Bun.$`git init -q --bare -b main ${origin}`.quiet();
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  await ensureProject("p", repo);
  const worker = await ensureWorktree("p", "task/fix");
  const before = await git(repo, "rev-parse", "HEAD");
  await git(worker, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  const oid = await git(worker, "rev-parse", "HEAD");
  await git(worker, "push", "origin", "task/fix", "HEAD:main");
  await Bun.write(join(repo, "draft"), "untouched");
  const check = mergeWatcher({ repo: async () => "o/r", live: async () => [], gh: async () => [{
    number: 1, headRefName: "task/fix", headRefOid: oid, url: "https://github.com/o/r/pull/1",
    mergedAt: new Date(Date.now() + 60_000).toISOString(), isCrossRepository: false,
  }] });
  expect(await check("p")).toEqual([1]);
  expect(existsSync(worker)).toBe(false);
  expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
  expect(await Bun.file(join(repo, "draft")).text()).toBe("untouched");
});
