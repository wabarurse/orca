// Crash-safe publication: rollback on failure, recovery after a crash at each phase, rollback failures surfaced.
// Two throwaway machines with temp ORCA_HOMEs; faults are injected through the publish hook, never real I/O errors.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conversationIds, paths, readProjectState, writeProjectState } from "../../config";
import { readSession } from "../data/projects/session-id";
import { allTasks, registerTask } from "../data/tasks";
import { exportSession } from "./export";
import { importSession, recoverSessions } from "./import";
import { resolveSelector } from "./local";
import { CrashForTest, pendingImports, recoverImports } from "./publish";
import { at, cleanup, loopback, machine, project, quiet, read, say, session, type Machine } from "../../test/session-fixture";

afterAll(cleanup);

const T1 = "11111111-1111-4111-8111-111111111111";
/** a has the session one step ahead of b: a longer transcript, a new task and another model. */
async function ahead() {
  const a = await machine("mac"), b = await machine("server");
  await project(a, "orch-aaaa", "demo"); await say(a, "orch-aaaa", ["hello", "hi there"]);
  expect((await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) })).code).toBe(0);
  const id = await at(b, () => resolveSelector("demo"));
  await say(a, "orch-aaaa", ["more", "answer"]);
  await at(a, async () => {
    await registerTask("orch-aaaa", { id: T1, name: "new task", summary: "s", branch: "feat/x", authorized: true });
    writeProjectState("orch-aaaa", "model", "claude-opus-5-5");
  });
  const bundle = await at(a, async () => (await exportSession("orch-aaaa", quiet())).bundle);
  return { a, b, id, bundle };
}
const into = (m: Machine, bytes: Uint8Array, opts: object = {}) => at(m, () => importSession(bytes, quiet(), { peer: "mac", ...opts }));
const stateOf = (m: Machine, id: string) => at(m, async () => ({
  transcript: await Bun.file(paths.transcript(id, "orchestrator")).text(), model: readProjectState<string>(id, "model"),
  tasks: (await allTasks(id)).length, sync: JSON.stringify(readSession(id)),
}));
const leftovers = (m: Machine) => at(m, () => existsSync(join(paths.root, "sync-staging")) ? readdir(join(paths.root, "sync-staging")) : []);

test("a failure part-way through publication rolls everything back: files, state keys, and the sync record", async () => {
  const { b, id, bundle } = await ahead();
  const before = await stateOf(b, id);
  for (const point of ["files", "state"]) {
    await expect(into(b, bundle, { hook: (p: string) => { if (p === point) throw new Error(`disk full at ${point}`); } })).rejects.toThrow(`disk full at ${point}`);
    expect(await stateOf(b, id)).toEqual(before);
    expect(await leftovers(b)).toEqual([]);
    expect(await at(b, () => pendingImports())).toEqual([]);
  }
  const ok = await into(b, bundle);
  expect(ok.outcome).toBe("updated");
  const after = await stateOf(b, id);
  expect(after.transcript).not.toBe(before.transcript);
  expect(after).toMatchObject({ model: "claude-opus-5-5", tasks: 1 });
});

test("a crash during publication leaves a journal; recovery rolls back before the commit point and completes after it", async () => {
  const { a, b, id, bundle } = await ahead();
  const before = await stateOf(b, id);
  const crash = (at_: string) => ({ hook: (p: string) => { if (p === at_) throw new CrashForTest(`killed at ${at_}`); } });
  // killed after the files were replaced, before the commit point: the next import (or `recover`) undoes it
  await expect(into(b, bundle, crash("files"))).rejects.toThrow("killed at files");
  expect((await stateOf(b, id)).transcript).not.toBe(before.transcript);
  expect(await at(b, () => pendingImports(id))).toEqual([`${id} (applying)`]);
  const blocked = await session(b, ["export", id, join(b.dir, "x.bundle")]);
  expect(blocked.code).toBe(1);
  expect(blocked.err).toContain("interrupted");
  const noStacking = await session(b, ["recover"]);
  expect(noStacking.code).toBe(0);
  expect(noStacking.err).toContain("rolled back the interrupted import");
  expect(await stateOf(b, id)).toEqual(before);
  expect(await leftovers(b)).toEqual([]);
  // killed after the commit point (state written, journal "committing"): recovery completes it, tasks and sync record included
  await expect(into(b, bundle, crash("tasks"))).rejects.toThrow("killed at tasks");
  expect(await at(b, () => pendingImports(id))).toEqual([`${id} (committing)`]);
  expect((await stateOf(b, id)).tasks).toBe(0);
  const next = await into(b, bundle); // any import settles the journal first
  expect(next.lines.join("\n")).toContain("completed the interrupted import");
  const done = await stateOf(b, id);
  expect(done).toMatchObject({ model: "claude-opus-5-5", tasks: 1 });
  expect(done.transcript).toBe(await read(a, "orch-aaaa", "transcript/orchestrator.jsonl"));
  expect(JSON.parse(done.sync).sync.peer).toBe("mac");
  expect(await leftovers(b)).toEqual([]);
  expect((await session(b, ["recover"])).err).toContain("no interrupted imports");
});

test("a crash while creating a project is undone by recovery: the half-made project goes", async () => {
  const { a, bundle } = await ahead();
  const c = await machine("third");
  await expect(into(c, bundle, { checkout: c.repo, hook: (p: string) => { if (p === "files") throw new CrashForTest("killed"); } })).rejects.toThrow("killed");
  expect(await at(c, () => conversationIds(paths.root))).toHaveLength(1);
  expect((await session(c, ["recover"])).err).toContain("rolled back");
  expect(await at(c, () => conversationIds(paths.root))).toEqual([]);
  expect((await into(c, bundle, { checkout: c.repo })).outcome).toBe("created");
  expect(a.name).toBe("mac");
});

test("a failure while creating a project removes the project again", async () => {
  const { bundle } = await ahead();
  const c = await machine("third");
  await expect(into(c, bundle, { checkout: c.repo, hook: (p: string) => { if (p === "state") throw new Error("boom"); } })).rejects.toThrow("boom");
  expect(await at(c, () => conversationIds(paths.root))).toEqual([]);
  expect(await leftovers(c)).toEqual([]);
});

test("a rollback that itself fails is reported with the backup and journal locations, keeps the journal, and recovery retries it", async () => {
  const { b, id, bundle } = await ahead();
  const before = await stateOf(b, id);
  const sabotage = async (p: string) => {
    if (p !== "files") return;
    const file = await at(b, () => paths.transcript(id, "orchestrator"));
    await rm(file); await mkdir(file); await writeFile(join(file, "x"), "in the way");
    throw new Error("disk full");
  };
  const error = await into(b, bundle, { hook: sabotage }).then(() => undefined, e => e as Error);
  expect(error?.message).toContain("rollback incomplete");
  expect(error?.message).toContain("orchestrator.jsonl");
  expect(error?.message).toContain("sync-backup");
  expect(error?.message).toContain("journal");
  expect(error?.message).toContain("orca session recover");
  expect(await at(b, () => pendingImports(id))).toEqual([`${id} (applying)`]);
  await at(b, async () => { const file = paths.transcript(id, "orchestrator"); await rm(file, { recursive: true, force: true }); });
  expect((await at(b, () => recoverImports()))[0]).toContain("rolled back");
  expect(await stateOf(b, id)).toEqual(before);
});

test("a sync record that cannot be written after the commit point is reported and completed by recovery", async () => {
  const { b, id, bundle } = await ahead();
  const error = await into(b, bundle, { hook: (p: string) => { if (p === "session") throw new Error("read-only"); } }).then(() => undefined, e => e as Error);
  expect(error?.message).toContain("complete except its sync record");
  expect(await at(b, () => pendingImports(id))).toEqual([`${id} (committing)`]);
  expect((await stateOf(b, id)).tasks).toBe(1); // the commit point was passed: tasks are in
  expect((await at(b, () => recoverImports()))[0]).toContain("completed");
  expect(JSON.parse((await stateOf(b, id)).sync).sync.peer).toBe("mac");
});

test("recover never rolls back an import that is still running: it takes the import lock, so the finished import is intact", async () => {
  const { b, id, bundle } = await ahead();
  const seen: string[] = [];
  const midway = async (p: string) => {
    if (p !== "files") return;           // the journal is "applying" and files are replaced: exactly what a stale recover would undo
    // Where kill is denied this very process looks dead to the lock; record the owner as another live process (pid 1), as holdLock does.
    await at(b, () => writeFile(join(paths.runtime, "session-import.lock", "owner.json"), JSON.stringify({ pid: 1, since: new Date().toISOString() })));
    seen.push((await session(b, ["recover"])).err);
    seen.push(await at(b, () => recoverSessions()).then(() => "recovered", e => (e as Error).message));
  };
  const ok = await into(b, bundle, { hook: midway });
  expect(ok.outcome).toBe("updated");
  expect(seen[0]).toContain("another session import is running");
  expect(seen[1]).toContain("another session import is running");
  const after = await stateOf(b, id);
  expect(after).toMatchObject({ model: "claude-opus-5-5", tasks: 1 });
  expect(await at(b, () => pendingImports())).toEqual([]);
});

test("a crash before the journal leaves only an unreferenced staging directory, which recovery removes; a crash right after it removes the half-made project", async () => {
  const a = await machine("mac"), b = await machine("server");
  await project(a, "orch-aaaa", "demo"); await say(a, "orch-aaaa", ["hello", "hi there"]);
  const bundle = await at(a, async () => (await exportSession("orch-aaaa", quiet())).bundle);
  const crash = (at_: string) => ({ hook: (p: string) => { if (p === at_) throw new CrashForTest(`killed at ${at_}`); } });
  const projects = () => at(b, () => conversationIds(paths.root));
  // before the journal: no project exists yet, staging holds files but no journal
  await expect(into(b, bundle, { checkout: b.repo, ...crash("staged") })).rejects.toThrow("killed at staged");
  expect(await projects()).toEqual([]);
  expect((await leftovers(b)).length).toBe(1);
  expect(await at(b, () => pendingImports())).toEqual([]);
  const first = await session(b, ["recover"]);
  expect(first.code).toBe(0);
  expect(first.err).toContain("incomplete staging directory");
  expect(await leftovers(b)).toEqual([]);
  // after the journal, before the folder is built (prepare) and after it: the journal names the project, recovery removes it
  for (const point of ["journal", "files"]) {
    await expect(into(b, bundle, { checkout: b.repo, ...crash(point) })).rejects.toThrow(`killed at ${point}`);
    expect((await at(b, () => pendingImports()))[0]).toContain("(applying)");
    expect((await session(b, ["recover"])).err).toContain("rolled back the interrupted import");
    expect(await projects()).toEqual([]);
    expect(await leftovers(b)).toEqual([]);
  }
  expect((await into(b, bundle, { checkout: b.repo })).outcome).toBe("created");
});
