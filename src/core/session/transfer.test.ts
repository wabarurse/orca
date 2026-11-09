// Session transfer end to end: two throwaway machines (temp ORCA_HOMEs), the ssh boundary replaced by an in-process
// peer. Fake data only: no provider, tmux or network.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, repositoryBinding } from "../../config";
import { setDisplayName } from "../data/projects";
import { readSession } from "../data/projects/session-id";
import { at, cleanup, exists, loopback, machine, project, read, say, session } from "../../test/session-fixture";
import { resolveSelector } from "./local";

afterAll(cleanup);

async function pair() {
  const a = await machine("mac"), b = await machine("server");
  await project(a, "orch-aaaa", "demo");
  await say(a, "orch-aaaa", ["hello", "hi there", "second", "reply two"]);
  await say(a, "orch-aaaa", ["work", "done"], "worker-feat-x");
  return { a, b };
}
const lines = (m: string) => m.split("\n").filter(Boolean);

test("push creates the project on a fresh machine bound to its own checkout, with the same transcripts byte for byte", async () => {
  const { a, b } = await pair();
  const r = await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  expect(r.err).toContain("created");
  expect(r.code).toBe(0);
  const id = await at(b, () => resolveSelector("demo"));
  for (const f of ["transcript/orchestrator.jsonl", "transcript/worker-feat-x.jsonl"]) expect(await read(b, id, f)).toBe(await read(a, "orch-aaaa", f));
  const [bindA, bindB] = [await at(a, () => repositoryBinding("orch-aaaa")!), await at(b, () => repositoryBinding(id)!)];
  expect(bindB.directory).toBe(b.repo);
  expect(bindB.worktreeId).not.toBe(bindA.worktreeId);
  const sidA = await at(a, () => readSession("orch-aaaa")!.sessionId), sidB = await at(b, () => readSession(id)!.sessionId);
  expect(sidB).toBe(sidA);
  const ledger = JSON.parse(await read(b, id, "session.json"));
  expect(ledger.sync.peer).toBe("mac");
  expect(Object.keys(ledger.sync.transcripts).sort()).toEqual(["orchestrator", "worker-feat-x"]);
  expect(r.err).toContain("no provider-side session");
});

test("fast-forward in both directions, equal is a no-op, destination newer is kept", async () => {
  const { a, b } = await pair();
  await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  const id = await at(b, () => resolveSelector("demo"));
  const same = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(same.code).toBe(0);
  expect(same.err).toContain("unchanged");
  expect(same.err).toContain("identical");
  await say(a, "orch-aaaa", ["more", "answer"]);
  const ff = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(ff.err).toContain("fast-forward (+2 entries");
  expect(await read(b, id, "transcript/orchestrator.jsonl")).toBe(await read(a, "orch-aaaa", "transcript/orchestrator.jsonl"));
  await say(b, id, ["b only", "b reply"]);
  const before = await read(b, id, "transcript/orchestrator.jsonl");
  const keep = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(keep.code).toBe(0);
  expect(keep.err).toContain("receiving side is newer");
  expect(await read(b, id, "transcript/orchestrator.jsonl")).toBe(before);
  const pull = await session(a, ["pull", "demo", "server"], { transport: loopback(b) });
  expect(pull.code).toBe(0);
  expect(pull.err).toContain("fast-forward");
  expect(await read(a, "orch-aaaa", "transcript/orchestrator.jsonl")).toBe(before);
});

test("divergence refuses the whole transfer with a per-side report and writes nothing", async () => {
  const { a, b } = await pair();
  await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  const id = await at(b, () => resolveSelector("demo"));
  await say(a, "orch-aaaa", ["a side", "a reply"]);
  await say(b, id, ["b side", "b reply", "b more"]);
  await say(a, "orch-aaaa", ["worker a"], "worker-feat-x"); // independent file: would fast-forward, must not be applied
  const snapshot = async () => [await read(b, id, "transcript/orchestrator.jsonl"), await read(b, id, "transcript/worker-feat-x.jsonl"), await read(b, id, "session.json")];
  const before = await snapshot();
  const r = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(r.code).toBe(1);
  expect(r.err).toContain("refused, nothing was written");
  expect(r.err).toContain("orchestrator: DIVERGED after 4 common entries; 2 only on the sending side");
  expect(r.err).toContain("3 only on the receiving side");
  expect(await snapshot()).toEqual(before);
  expect(existsSync(join(b.home, "sync-backup"))).toBe(false);
  expect(existsSync(join(b.home, "sync-staging")) ? (await Bun.$`ls ${join(b.home, "sync-staging")}`.text()) : "").toBe("");
  const pull = await session(a, ["pull", "demo", "server"], { transport: loopback(b) });
  expect(pull.code).toBe(1);
  expect(pull.err).toContain("DIVERGED");
});

test("--as imports the incoming side as a separate project with a fresh folder id and session id, non-lossy", async () => {
  const { a, b } = await pair();
  await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  const original = await at(b, () => resolveSelector("demo"));
  await say(a, "orch-aaaa", ["a side", "a reply"]);
  await say(b, original, ["b side", "b reply"]);
  const r = await session(a, ["push", "demo", "server", "--as", "demo-from-mac", "--checkout", b.repo], { transport: loopback(b) });
  expect(r.code).toBe(0);
  expect(r.err).toContain("forked");
  const fork = await at(b, () => resolveSelector("demo-from-mac"));
  expect(fork).not.toBe(original);
  expect(await read(b, fork, "transcript/orchestrator.jsonl")).toBe(await read(a, "orch-aaaa", "transcript/orchestrator.jsonl"));
  const sessions = await at(b, () => [readSession(original)!.sessionId, readSession(fork)!.sessionId]);
  expect(sessions[0]).not.toBe(sessions[1]);
  expect(JSON.parse(await read(b, fork, "session.json")).sync.forkedFrom).toBe(sessions[0]);
  expect(await read(b, original, "transcript/orchestrator.jsonl")).toContain("b side");
});

test("--as with a name that is taken is refused and writes nothing", async () => {
  const { a, b } = await pair();
  await project(b, "orch-bbbb", "taken");
  const r = await session(a, ["push", "demo", "server", "--as", "taken", "--checkout", b.repo], { transport: loopback(b) });
  expect(r.code).toBe(1);
  expect(r.err).toContain('already called "taken"');
  expect(await at(b, () => existsSync(paths.project("orch-aaaa")))).toBe(false);
  expect(await at(b, () => resolveSelector("taken"))).toBe("orch-bbbb");
});

test("a new project without --checkout is refused; a clone of another repository is refused", async () => {
  const { a, b } = await pair();
  const none = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(none.code).toBe(1);
  expect(none.err).toContain("--checkout");
  expect(await at(b, () => existsSync(join(paths.root, "projects")))).toBe(false);
  const other = await machine("elsewhere", "https://example.invalid/org/other.git");
  const wrong = await session(a, ["push", "demo", "server", "--checkout", other.repo], { transport: loopback(b) });
  expect(wrong.code).toBe(1);
  expect(wrong.err).toContain("other.git");
  const ssh = await machine("sshform", "git@example.invalid:org/repo.git");
  expect((await session(a, ["push", "demo", "server", "--checkout", ssh.repo, "--dry-run"], { transport: loopback(b) })).code).toBe(0);
});

test("the session id is stable across /rename, and selectors resolve session id, then display name, then folder id", async () => {
  const { a } = await pair();
  const id = await at(a, async () => { await session(a, ["export", "demo", join(a.dir, "x.bundle")]); return readSession("orch-aaaa")!.sessionId; });
  await at(a, () => setDisplayName("orch-aaaa", "renamed"));
  expect(await at(a, () => readSession("orch-aaaa")!.sessionId)).toBe(id);
  expect(await at(a, () => resolveSelector(id))).toBe("orch-aaaa");
  expect(await at(a, () => resolveSelector("renamed"))).toBe("orch-aaaa");
  expect(await at(a, () => resolveSelector("orch-aaaa"))).toBe("orch-aaaa");
  await at(a, () => expect(resolveSelector("nothing")).rejects.toThrow("no project matches"));
});

test("an ambiguous display name is refused, never guessed", async () => {
  const a = await machine("mac");
  await project(a, "orch-cccc", "dup"); await say(a, "orch-cccc", ["x", "y"]);
  await project(a, "orch-dddd", "other");
  // two projects cannot share a name through /rename, but a name can equal another project's folder id, and a stored name may predate the rule
  await at(a, async () => { const { writeProjectState } = await import("../../config"); writeProjectState("orch-dddd", "name", "dup"); });
  await at(a, () => expect(resolveSelector("dup")).rejects.toThrow("names 2 projects"));
  const r = await session(a, ["export", "dup", join(a.dir, "d.bundle")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("names 2 projects");
  expect(existsSync(join(a.dir, "d.bundle"))).toBe(false);
});

test("a rename on one machine does not fork identity: the push matches by session id and applies the new name", async () => {
  const { a, b } = await pair();
  await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  const id = await at(b, () => resolveSelector("demo"));
  await at(a, () => setDisplayName("orch-aaaa", "demo-2"));
  await say(a, "orch-aaaa", ["x", "y"]);
  const r = await session(a, ["push", "demo-2", "server"], { transport: loopback(b) });
  expect(r.code).toBe(0);
  expect(r.err).toContain('name: "demo-2"');
  expect(await at(b, () => resolveSelector("demo-2"))).toBe(id);
  await project(b, "orch-bbbb", "taken");
  await at(a, () => setDisplayName("orch-aaaa", "taken"));
  await say(a, "orch-aaaa", ["p", "q"]);
  const c = await session(a, ["push", "taken", "server"], { transport: loopback(b) });
  expect(c.code).toBe(0);
  expect(c.err).toContain('kept "demo-2"');
});

test("dry-run reports the plan and writes nothing, not even a session id", async () => {
  const { a, b } = await pair();
  const r = await session(a, ["push", "demo", "server", "--checkout", b.repo, "--dry-run"], { transport: loopback(b) });
  expect(r.code).toBe(0);
  expect(r.err).toContain("[dry run]");
  expect(await at(a, () => readSession("orch-aaaa"))).toBeUndefined();
  expect(await exists(a, "orch-aaaa", "session.json")).toBe(false);
  expect(await at(b, () => existsSync(join(paths.root, "projects")))).toBe(false);
});

test("replaced files are backed up under sync-backup, never inside the project", async () => {
  const { a, b } = await pair();
  await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  const id = await at(b, () => resolveSelector("demo"));
  const old = await read(b, id, "transcript/orchestrator.jsonl");
  await say(a, "orch-aaaa", ["new", "newer"]);
  const r = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  const backup = /backed up to (\S+)/.exec(r.err)?.[1];
  expect(backup).toContain(join(b.home, "sync-backup", id));
  expect(await Bun.file(join(backup!, "project", "transcript", "orchestrator.jsonl")).text()).toBe(old);
  expect(lines(await at(b, () => Bun.$`ls ${join(paths.project(id), "transcript")}`.text())).sort()).toEqual(["orchestrator.jsonl", "worker-feat-x.jsonl"]);
});
