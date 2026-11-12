import { writeProjectState } from "../../../config";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, repositoryBinding } from "../../../config/config";
import { ensureProject, createOrchestrator } from "../../agent-loop/orc/orchestrator";
import { ensureWorktree, removeWorktree } from "../../tmux/runner";
import { deleteProject, restoreConversations } from "../../../tui/commands/project";
import { listProjects, projectFor, repoHere, remoteOf } from "./registry";
import { assertMainCheckout } from "./workspace";
import { conversationTurnLock } from "./state";
import { lockOwner, tryStorageLock } from "../storage-lock";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import { bash } from "../../tools/bash/bash";
import { registerTask, observeTaskPR } from "../tasks";
import { mergeWatcher } from "../../tmux/merges";

let temp: string, repo: string, previous: string | undefined;
const quiet = { live: async () => [], stop: async () => {}, kill: async () => {} };
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

test("ordinary directories work without Git, reopen by exact directory, and never become disposable worktrees", async () => {
  const folder = join(temp, "notes"), sibling = join(temp, "other notes");
  mkdirSync(folder); mkdirSync(sibling);
  await Bun.write(join(folder, "notes.txt"), "keep this");
  const oldPath = process.env.PATH;
  process.env.PATH = "";
  try {
    expect(await repoHere(folder)).toBe(folder);
    await ensureProject("plain", folder);
    expect(await projectFor(folder)).toBe("plain");
    expect(await projectFor(sibling)).toBeNull();
    expect(repositoryBinding("plain")?.branch).toBe("");
    const task = await registerTask("plain", { name: "Organize notes", summary: "Local work", branch: "notes-worker", authorized: true });
    expect(task.status).toBe("queued");
    expect(await remoteOf("plain")).toBe("no remote");
    await assertMainCheckout("plain");
    expect(await ensureWorktree("plain", "notes-worker")).toBe(folder);
    expect(paths.worktree("plain", "notes-worker")).toBe(folder);
    await removeWorktree("plain", "notes-worker");
    expect(await Bun.file(join(folder, "notes.txt")).text()).toBe("keep this");
    expect(existsSync(join(folder, ".git"))).toBe(false);
    const provider = fakeProvider([[text("done")]]);
    const orch = await createOrchestrator({ project: "plain", provider, tools: {}, write: () => {} });
    try { await orch.say("help with my notes"); await orch.turn(); }
    finally { orch.dispose?.(); }
    expect(provider.calls).toHaveLength(1);
    await deleteProject("plain", { live: async () => [], stop: async () => {}, kill: async () => {} });
    expect(await Bun.file(join(folder, "notes.txt")).text()).toBe("keep this");
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});

test("Finder metadata alone does not block conversation deletion", async () => {
  await ensureProject("finder", repo);
  const root = paths.worktrees("finder"); mkdirSync(root, { recursive: true });
  await Bun.write(join(root, ".DS_Store"), "Finder metadata");
  const calls: string[] = [];
  await deleteProject("finder", { live: async () => [], stop: async () => { calls.push("stop"); }, kill: async () => { calls.push("kill"); } });
  expect(calls).toEqual(["stop", "kill"]);
  expect(existsSync(root)).toBe(false);
  expect(existsSync(paths.project("finder"))).toBe(false);
  expect(existsSync(join(repo, ".git"))).toBe(true);
});

test("Finder metadata beside a clean worktree is removed without deleting its branch", async () => {
  await ensureProject("finder", repo);
  const tree = await ensureWorktree("finder", "feat/clean");
  await Bun.write(join(paths.worktrees("finder"), ".DS_Store"), "Finder metadata");
  await deleteProject("finder", quiet);
  expect(existsSync(tree)).toBe(false);
  expect(existsSync(paths.worktrees("finder"))).toBe(false);
  expect(await git(repo, "branch", "--list", "feat/clean")).toContain("feat/clean");
});

test("unexpected worktree entries get an actionable error before stopping the daemon", async () => {
  await ensureProject("finder", repo);
  const root = paths.worktrees("finder"); mkdirSync(root, { recursive: true });
  const draft = join(root, "report.md"); await Bun.write(draft, "keep this report");
  await Bun.write(join(root, ".DS_Store"), "Finder metadata");
  const calls: string[] = [];
  await expect(deleteProject("finder", { live: async () => [], stop: async () => { calls.push("stop"); }, kill: async () => { calls.push("kill"); } })).rejects.toThrow(draft);
  expect(calls).toEqual([]);
  expect(await Bun.file(draft).text()).toBe("keep this report");
  expect(existsSync(paths.project("finder"))).toBe(true);
});

test("a directory or link named .DS_Store is preserved and never treated as disposable metadata", async () => {
  await ensureProject("finder", repo);
  const root = paths.worktrees("finder"); mkdirSync(root, { recursive: true });
  const metadata = join(root, ".DS_Store"); symlinkSync(repo, metadata);
  await expect(deleteProject("finder", quiet)).rejects.toThrow("unexpected file");
  expect(existsSync(join(repo, ".git"))).toBe(true);
  rmSync(metadata); mkdirSync(metadata);
  await Bun.write(join(metadata, "draft"), "keep");
  await expect(deleteProject("finder", quiet)).rejects.toThrow("cannot inspect worktree");
  expect(existsSync(paths.project("finder"))).toBe(true);
  expect(await Bun.file(join(metadata, "draft")).text()).toBe("keep");
});

test("startup automatically creates and reopens an ordinary folder without unrelated conversations", async () => {
  const folder = join(temp, "plain startup"); mkdirSync(folder);
  await ensureProject("unrelated", repo);
  const opened: string[] = [];
  const open = async (id: string, directory?: string) => { await ensureProject(id, directory); opened.push(id); };
  await restoreConversations({ source: folder, open, note: () => {} });
  expect(opened).toHaveLength(1);
  const id = opened[0]!;
  expect(paths.repo(id)).toBe(folder);
  opened.length = 0;
  await restoreConversations({ source: folder, open, note: () => {} });
  expect([...new Set(opened)]).toEqual([id]);
  expect(opened).not.toContain("unrelated");
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
  expect(worker).toBe(join(realpathSync(paths.root), "worktrees", `original-with-spaces--${repositoryBinding("p")!.worktreeId.slice(0, 8)}`, "task-fix"));
  expect(existsSync(`${repo}.orca-worktrees`)).toBe(false);
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

test("same-checkout conversations run overlapping turns with separate worktree namespaces", async () => {
  await ensureProject("p", repo);
  await ensureProject("q", repo);
  expect(paths.worktrees("q")).not.toBe(paths.worktrees("p"));
  const first = fakeProvider([[text("first")]]), second = fakeProvider([[text("second")]]);
  const p = await createOrchestrator({ project: "p", provider: first, write: () => {} });
  const q = await createOrchestrator({ project: "q", provider: second, write: () => {} });
  const completeFirst = first.complete.bind(first), completeSecond = second.complete.bind(second);
  second.complete = async req => {
    expect((await lockOwner(conversationTurnLock("p")))?.project).toBe("p");
    expect((await lockOwner(conversationTurnLock("q")))?.project).toBe("q");
    return completeSecond(req);
  };
  first.complete = async req => {
    await q.say("go in parallel");
    expect(await q.pending()).toBe(true);
    await q.turn();
    expect(second.calls).toHaveLength(1);
    return completeFirst(req);
  };
  try {
    await p.say("go first");
    await p.turn();
    expect(first.calls).toHaveLength(1);
    expect(existsSync(conversationTurnLock("p"))).toBe(false);
    expect(existsSync(conversationTurnLock("q"))).toBe(false);
  } finally { p.dispose?.(); q.dispose?.(); }
});

test("an active conversation blocks its own deletion and allows deleting an idle sibling", async () => {
  await ensureProject("p", repo);
  await ensureProject("q", repo);
  const sibling = await tryStorageLock(conversationTurnLock("p"), "p");
  expect(sibling).toBeDefined();
  const opts = { live: async () => [], kill: async () => {} };
  try {
    await deleteProject("q", opts);
    expect(existsSync(paths.project("q"))).toBe(false);
    expect(existsSync(paths.project("p"))).toBe(true);
    const refusal = await deleteProject("p", opts).catch((error: Error) => error.message);
    expect(refusal).toContain("p orchestrator is mid-turn in another session");
    expect(refusal).toContain(`pid ${process.pid} (p) since `);
    expect(refusal).toContain("wait for that turn to end");
    expect(existsSync(paths.project("p"))).toBe(true);
  } finally { await sibling?.(); }
  // An unreadable owner is never taken over, and the message says where the lock is.
  mkdirSync(conversationTurnLock("p"), { recursive: true });
  const unknown = await deleteProject("p", opts).catch((error: Error) => error.message);
  expect(unknown).toContain(`${conversationTurnLock("p")} is held by an unknown owner`);
  rmSync(conversationTurnLock("p"), { recursive: true });
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
  writeProjectState("p", "repository", {});
  expect(() => repositoryBinding("p")).toThrow("invalid repository binding");
  await expect(ensureProject("p")).rejects.toThrow("invalid repository binding");
});

test("new remote sources, nested state and worker checkouts are refused without cloning", async () => {
  await expect(ensureProject("remote", "https://example.invalid/repo.git")).rejects.toThrow("existing local directory");
  await expect(ensureProject("empty", temp)).rejects.toThrow("ORCA_HOME must be separate");
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

test("merge observation preserves both worktree and original checkout", async () => {
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
  const task = await registerTask("p", { name: "Fix", summary: "Work", branch: "task/fix", authorized: true });
  const pr = { repository: "o/r", number: 1, head: oid, url: "https://github.com/o/r/pull/1" };
  await observeTaskPR("p", task.id, { pr, branch: "task/fix", state: "OPEN", ready: false, checks: "unknown" });
  const check = mergeWatcher({ repo: async () => "o/r", pr: async () => ({ pr, branch: "task/fix", state: "MERGED", mergedAt: new Date().toISOString(), ready: false, checks: "unknown" }) });
  expect(await check("p")).toEqual([1]);
  expect(existsSync(worker)).toBe(true);
  expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
  expect(await Bun.file(join(repo, "draft")).text()).toBe("untouched");
});
