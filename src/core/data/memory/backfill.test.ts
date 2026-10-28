import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { archiveBestEffort, archivePath, archiveTranscript, BATCH, database, entryText, queryHistory, sync } from "./archive";
import { withProjectStateLock } from "../projects/state";
import { backfillMemory, cleanOrphans, startMemoryBackfill } from "./backfill";
import { prepareTaskRun, registerTask, startTaskRun } from "../tasks/tasks";
import { open } from "../transcripts/transcript";
import type { Entry } from "../../../protocol/transcript";

const previous = process.env.ORCA_HOME, dirs: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const home = () => { const dir = mkdtempSync(join(tmpdir(), "memory-backfill-")); dirs.push(dir); process.env.ORCA_HOME = dir; return dir; };
const oldFile = (project: string) => join(paths.project(project), "memory.sqlite");
const siblings = (project: string) => ["", "-wal", "-shm", "-journal"].map(s => oldFile(project) + s);
const globalRows = <T>(sql: string, ...params: string[]) => {
  const db = new Database(archivePath(), { readonly: true });
  try { return db.query(sql).all(...params) as T[]; } finally { db.close(); }
};

/** A per-project index exactly as the previous release wrote it. */
function writeOldIndex(project: string, entries: Entry[], extra: Entry[] = []) {
  const db = new Database(oldFile(project), { create: true, strict: true });
  db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, kind TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL, raw TEXT NOT NULL);
    CREATE VIRTUAL TABLE entry_search USING fts5(body, content='entries', content_rowid='rowid');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, raw TEXT NOT NULL);
    CREATE TABLE entry_tasks (entry_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(entry_id, task_id));`);
  for (const e of [...entries, ...extra]) {
    const body = entryText(e), r = db.query("INSERT INTO entries VALUES(?,?,?,?,?,?)").run(e.uuid, "initial", e.type, e.ts, body, JSON.stringify(e));
    db.query("INSERT INTO entry_search(rowid,body) VALUES(?,?)").run(r.lastInsertRowid, body);
  }
  db.close();
  for (const s of ["-wal", "-shm", "-journal"]) writeFileSync(oldFile(project) + s, "leftover");
}
async function project(name: string, texts: string[], withTask = false) {
  mkdirSync(paths.project(name), { recursive: true });
  const transcript = open(paths.transcript(name, "orchestrator"));
  const task = withTask ? await registerTask(name, { name: `Task of ${name}`, summary: "walrus", branch: "feat/x", authorized: true }) : undefined;
  for (const [i, t] of texts.entries()) await transcript.append({ type: "message", message: { role: i % 2 ? "assistant" : "user", content: task && i === 0 ? `${t} ${task.id}` : t } });
  if (name.includes("clear")) await transcript.append({ type: "context-boundary" });
  return { transcript, entries: transcript.all!(), task };
}
const snapshot = () => globalRows<{ project: string; id: string; epoch: string; body: string; raw: string }>("SELECT project,id,epoch,body,raw FROM entries ORDER BY project,id");
const meta = (key: string) => globalRows<{ value: string }>("SELECT value FROM meta WHERE key=?", key)[0]?.value;

test("backfill is lossless: every entry and task of every project lands in the global file, old files go", async () => {
  home();
  const a = await project("alpha", ["walrus one", "two", "three"], true), b = await project("beta-clear", ["before", "after"]);
  await project("gamma", ["no old index here"]);
  writeOldIndex("alpha", a.entries); writeOldIndex("beta-clear", b.entries.slice(0, 1));
  await prepareTaskRun("alpha", a.task!.id, a.task!.branch, { id: "run-1", agent: "worker-feat-x", role: "worker" }); await startTaskRun("alpha", "run-1");
  expect(await backfillMemory()).toBe(true);
  const rows = snapshot();
  expect(rows).toHaveLength(a.entries.length + b.entries.length + 1);
  for (const e of [...a.entries, ...b.entries]) expect(rows.find(r => r.id === e.uuid)?.raw).toBe(JSON.stringify(e));
  expect(rows.find(r => r.id === b.entries[0]!.uuid)?.epoch).toBe("initial");
  expect(rows.find(r => r.id === b.entries.at(-1)!.uuid)?.epoch).toBe(b.entries.at(-1)!.uuid);
  expect(globalRows("SELECT 1 FROM tasks WHERE project='alpha' AND id=? AND revision>=?", a.task!.id, String(a.task!.revision))).toHaveLength(1);
  expect(globalRows<{ started_at: string | null; ended_at: string | null }>("SELECT started_at,ended_at FROM tasks WHERE project='alpha'")).toEqual([{ started_at: expect.stringMatching(/^\d{4}-/), ended_at: null }]);
  for (const f of [...siblings("alpha"), ...siblings("beta-clear")]) expect(existsSync(f)).toBe(false);
  expect(meta("backfill_version")).toBe("1");
  expect(meta("backfill:alpha")).toBeDefined(); expect(meta("backfill:gamma")).toBeDefined();
  expect(JSON.parse(await queryHistory("alpha", { action: "search_history", query: "walrus" })).entries).toHaveLength(1);
  expect(globalRows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(1);
});

test("backfill is idempotent and skips finished work on later starts", async () => {
  home();
  const a = await project("alpha", ["one", "two"]);
  writeOldIndex("alpha", a.entries);
  expect(await backfillMemory()).toBe(true);
  const before = snapshot(), at = globalRows("SELECT indexed_at FROM sources");
  expect(await backfillMemory()).toBe(true);
  expect(snapshot()).toEqual(before); expect(globalRows("SELECT indexed_at FROM sources")).toEqual(at);
  rmSync(archivePath()); // a rebuilt file backfills again, to the same rows
  expect(await backfillMemory()).toBe(true);
  expect(snapshot().map(r => [r.id, r.body, r.raw])).toEqual(before.map(r => [r.id, r.body, r.raw]));
});

test("an unreadable transcript keeps that project's old files; others migrate; a later run finishes", async () => {
  home();
  const a = await project("alpha", ["one", "two"]), b = await project("beta", ["three"]);
  writeOldIndex("alpha", a.entries); writeOldIndex("beta", b.entries);
  rmSync(paths.transcript("beta", "orchestrator")); mkdirSync(paths.transcript("beta", "orchestrator")); // cannot be read as a file
  const logs: string[] = [];
  expect(await backfillMemory({ log: m => logs.push(m) })).toBe(false);
  expect(siblings("alpha").some(existsSync)).toBe(false);
  expect(siblings("beta").every(existsSync)).toBe(true);
  expect(logs.join("\n")).toContain("beta");
  expect(meta("backfill_version")).toBeUndefined(); expect(meta("backfill:beta")).toBeUndefined(); expect(meta("backfill:alpha")).toBeDefined();
  rmSync(paths.transcript("beta", "orchestrator"), { recursive: true });
  writeFileSync(paths.transcript("beta", "orchestrator"), b.entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  expect(await backfillMemory()).toBe(true);
  expect(siblings("beta").some(existsSync)).toBe(false);
  expect(globalRows("SELECT 1 FROM entries WHERE project='beta'")).toHaveLength(1);
  expect(meta("backfill_version")).toBe("1");
});

test("a verification mismatch keeps the old files and the project is retried later", async () => {
  home();
  const a = await project("alpha", ["one", "two"], true);
  writeOldIndex("alpha", a.entries);
  const logs: string[] = [];
  const corrupt = (_p: string, db: Database) => { db.exec(`UPDATE entries SET body='tampered' WHERE id='${a.entries[0]!.uuid}'`); };
  expect(await backfillMemory({ log: m => logs.push(m), afterIndex: corrupt })).toBe(false);
  expect(siblings("alpha").every(existsSync)).toBe(true);
  expect(logs.join()).toContain("differs"); expect(meta("backfill:alpha")).toBeUndefined();
  for (const hide of [`DELETE FROM entries WHERE id='${a.entries[1]!.uuid}'`, `UPDATE tasks SET revision=0`]) {
    for (const f of ["", "-wal", "-shm"]) rmSync(archivePath() + f, { force: true });
    const gone = (_p: string, db: Database) => { db.exec(hide); };
    expect(await backfillMemory({ afterIndex: gone })).toBe(false);
    expect(siblings("alpha").every(existsSync)).toBe(true);
  }
  for (const f of ["", "-wal", "-shm"]) rmSync(archivePath() + f, { force: true });
  expect(await backfillMemory()).toBe(true); // nothing wrong this time
  expect(siblings("alpha").some(existsSync)).toBe(false);
});

test("a stale task row blocks deletion", async () => {
  home();
  const a = await project("alpha", ["one"], true);
  writeOldIndex("alpha", a.entries);
  const stale = (_p: string, db: Database) => { db.exec("UPDATE tasks SET revision=0"); };
  expect(await backfillMemory({ afterIndex: stale })).toBe(false);
  expect(existsSync(oldFile("alpha"))).toBe(true);
});

test("an old index holding entries the transcript no longer yields is the only copy: kept", async () => {
  home();
  const a = await project("alpha", ["one", "two", "three"]);
  writeOldIndex("alpha", a.entries);
  const path = paths.transcript("alpha", "orchestrator"), lines = (await Bun.file(path).text()).trimEnd().split("\n");
  writeFileSync(path, lines.slice(0, 1).join("\n") + "\n{damaged"); // later records lost
  const logs: string[] = [];
  expect(await backfillMemory({ log: m => logs.push(m) })).toBe(false);
  expect(siblings("alpha").every(existsSync)).toBe(true);
  expect(logs.join()).toContain("no longer yields");
});

test("an unreadable tasks.json keeps the old files", async () => {
  home();
  const a = await project("alpha", ["one"]);
  writeOldIndex("alpha", a.entries);
  writeFileSync(join(paths.project("alpha"), "tasks.json"), "{not json");
  expect(await backfillMemory()).toBe(false);
  expect(siblings("alpha").every(existsSync)).toBe(true);
});

test("the old file is never deleted before the global rows exist", async () => {
  home();
  const a = await project("alpha", ["one"]);
  writeOldIndex("alpha", a.entries);
  let seen: boolean | undefined;
  await backfillMemory({ afterIndex: () => { seen = existsSync(oldFile("alpha")); } });
  expect(seen).toBe(true); expect(existsSync(oldFile("alpha"))).toBe(false);
});

test("a crash after deleting but before marking is repaired by the next run", async () => {
  home();
  const a = await project("alpha", ["one"]);
  writeOldIndex("alpha", a.entries);
  expect(await backfillMemory()).toBe(true);
  const db = new Database(archivePath());
  db.exec("DELETE FROM meta"); db.close();
  expect(await backfillMemory()).toBe(true);
  expect(meta("backfill:alpha")).toBeDefined(); expect(snapshot()).toHaveLength(1);
});

test("orphan rows of projects whose folder is gone are cleaned, FTS included", async () => {
  home();
  await project("alpha", ["walrus alpha"], true); await project("ghost", ["walrus ghost"], true);
  expect(await backfillMemory()).toBe(true);
  expect(globalRows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(2);
  rmSync(paths.project("ghost"), { recursive: true });
  const db = new Database(archivePath()); db.exec("DELETE FROM meta WHERE key='backfill_version'"); db.close();
  expect(await backfillMemory()).toBe(true);
  for (const t of ["entries", "tasks", "entry_tasks", "sources"]) expect(globalRows(`SELECT 1 FROM ${t} WHERE project='ghost'`)).toEqual([]);
  expect(meta("backfill:ghost")).toBeUndefined();
  expect(globalRows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(1);
  expect(globalRows("SELECT 1 FROM entries WHERE project='alpha'")).toHaveLength(1);
});

test("worker and reviewer transcripts are not migrated and an old index of them is irrelevant", async () => {
  home();
  const a = await project("alpha", ["orchestrator text"]);
  const worker = open(paths.transcript("alpha", "worker-feat-x"));
  await worker.append({ type: "message", message: { role: "user", content: "WORKER_ONLY" } });
  writeOldIndex("alpha", a.entries);
  expect(await backfillMemory()).toBe(true);
  expect(globalRows("SELECT 1 FROM entries WHERE raw LIKE '%WORKER_ONLY%'")).toEqual([]);
});

test("startup backfill is fire-and-forget, deduplicated and never rejects", async () => {
  const dir = home();
  const a = await project("alpha", ["one"]);
  writeOldIndex("alpha", a.entries);
  const first = startMemoryBackfill(), second = startMemoryBackfill();
  expect(second).toBe(first);
  expect(await first).toBe(true);
  expect(existsSync(oldFile("alpha"))).toBe(false);
  mkdirSync(join(dir, "other")); // an unusable archive: reported, not thrown
  process.env.ORCA_HOME = join(dir, "other"); mkdirSync(archivePath(), { recursive: true });
  const logs: string[] = [];
  expect(await startMemoryBackfill({ log: m => logs.push(m) })).toBe(false);
  expect(logs).toHaveLength(1);
});

test("a copy or read failure keeps the old file instead of deleting it unverified", async () => {
  home();
  const a = await project("alpha", ["one"]), b = await project("beta", ["two"]);
  writeOldIndex("alpha", a.entries); writeOldIndex("beta", b.entries);
  rmSync(oldFile("beta")); mkdirSync(oldFile("beta")); // cannot be copied as a file
  const logs: string[] = [];
  expect(await backfillMemory({ log: m => logs.push(m) })).toBe(false);
  expect(existsSync(oldFile("beta"))).toBe(true); expect(logs.join()).toContain("beta");
  expect(existsSync(oldFile("alpha"))).toBe(false);
  rmSync(oldFile("beta"), { recursive: true }); writeOldIndex("beta", b.entries);
  if (process.getuid?.() !== 0) {
    chmodSync(oldFile("beta"), 0o000); // EACCES on copy
    expect(await backfillMemory()).toBe(false);
    expect(existsSync(oldFile("beta"))).toBe(true);
    chmodSync(oldFile("beta"), 0o600);
  }
  expect(await backfillMemory()).toBe(true);
  expect(existsSync(oldFile("beta"))).toBe(false);
});

test("garbage and zero-length old files are deleted, but only after the transcript rebuild verified", async () => {
  home();
  const a = await project("alpha", ["one", "two"]), b = await project("beta", ["three"]);
  writeFileSync(oldFile("alpha"), "this is definitely not a sqlite database ".repeat(40));
  writeFileSync(oldFile("beta"), "");
  writeFileSync(join(paths.project("alpha"), "tasks.json"), "{not json"); // alpha cannot be verified yet
  expect(await backfillMemory()).toBe(false);
  expect(existsSync(oldFile("alpha"))).toBe(true);
  expect(existsSync(oldFile("beta"))).toBe(false); // verified rebuild of beta
  expect(globalRows("SELECT 1 FROM entries WHERE project='beta'")).toHaveLength(b.entries.length);
  rmSync(join(paths.project("alpha"), "tasks.json"));
  expect(await backfillMemory()).toBe(true);
  expect(existsSync(oldFile("alpha"))).toBe(false);
  expect(globalRows("SELECT 1 FROM entries WHERE project='alpha'")).toHaveLength(a.entries.length);
});

test("orphan cleanup runs on every start, even after the migration completed", async () => {
  home();
  await project("alpha", ["walrus alpha"], true); await project("ghost", ["walrus ghost"], true);
  expect(await backfillMemory()).toBe(true);
  expect(meta("backfill_version")).toBe("1");
  rmSync(paths.project("ghost"), { recursive: true }); // deleted while the purge failed or was skipped
  expect(globalRows("SELECT 1 FROM entries WHERE project='ghost'")).toHaveLength(1);
  expect(await backfillMemory()).toBe(true);
  for (const t of ["entries", "tasks", "entry_tasks", "sources"]) expect(globalRows(`SELECT 1 FROM ${t} WHERE project='ghost'`)).toEqual([]);
  expect(globalRows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(1);
  // another process re-indexes a project just after its deletion and purge
  const db = database();
  try { await sync(db, "late", [await open(paths.transcript("alpha", "orchestrator")).append({ type: "message", message: { role: "user", content: "stray" } })], []); } finally { db.close(); }
  expect(globalRows("SELECT 1 FROM entries WHERE project='late'")).toHaveLength(1);
  await startMemoryBackfill().catch(() => {}); // deduplicated within a process: use the direct call as the restart
  cleanOrphans();
  expect(globalRows("SELECT 1 FROM sources WHERE project='late'")).toEqual([]);
});

test("aborting stops between projects, releases every project lock and keeps unverified old files", async () => {
  const dir = home();
  const a = await project("alpha", ["one"]), b = await project("beta", ["two"]);
  writeOldIndex("alpha", a.entries); writeOldIndex("beta", b.entries);
  const stop = new AbortController();
  await expect(backfillMemory({ signal: stop.signal, afterIndex: () => stop.abort(new Error("leaving")) })).rejects.toThrow("leaving");
  expect(existsSync(join(dir, ".runtime", "project-locks", "alpha"))).toBe(false);
  expect(existsSync(join(dir, ".runtime", "project-locks", "beta"))).toBe(false);
  expect(existsSync(oldFile("alpha"))).toBe(true); expect(existsSync(oldFile("beta"))).toBe(true);
  expect(meta("backfill_version")).toBeUndefined();
  expect(await backfillMemory()).toBe(true); // a later start finishes
  expect(existsSync(oldFile("alpha")) || existsSync(oldFile("beta"))).toBe(false);
});

test("the shared startup run stops once every session that started it has been disposed", async () => {
  const dir = home();
  const a = await project("alpha", ["one"]);
  writeOldIndex("alpha", a.entries);
  const one = new AbortController(), two = new AbortController();
  const run = startMemoryBackfill({ signal: one.signal });
  void startMemoryBackfill({ signal: two.signal });
  one.abort(); two.abort();
  expect(await run).toBe(false);
  expect(existsSync(join(dir, ".runtime", "project-locks", "alpha"))).toBe(false);
  expect(meta("backfill_version")).toBeUndefined();
});

test("indexing is batched and resumable: an interruption keeps whole batches and the next run completes without duplicates", async () => {
  home();
  mkdirSync(paths.project("big"), { recursive: true });
  const transcript = open(paths.transcript("big", "orchestrator"));
  for (let i = 0; i < BATCH * 2 + 50; i++) await transcript.append({ type: "message", message: { role: i % 2 ? "assistant" : "user", content: `message ${i}` } });
  const total = transcript.all!().length;
  let checks = 0;
  const stopping = { throwIfAborted() { if (++checks === 3) throw new Error("interrupted"); } } as unknown as AbortSignal;
  await expect(archiveTranscript("big", transcript, { signal: stopping })).rejects.toThrow("interrupted");
  const partial = globalRows<{ n: number }>("SELECT count(*) AS n FROM entries WHERE project='big'")[0]!.n;
  expect(partial).toBe(BATCH * 2);
  expect(globalRows<{ indexed_through: string }>("SELECT indexed_through FROM sources WHERE project='big'")[0]!.indexed_through).toBe(transcript.all!()[BATCH * 2 - 1]!.uuid);
  await archiveTranscript("big", transcript);
  await archiveTranscript("big", transcript);
  expect(globalRows<{ n: number }>("SELECT count(*) AS n FROM entries WHERE project='big'")[0]!.n).toBe(total);
  expect(globalRows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'message'")).toHaveLength(total);
});

test("/clear's best-effort indexing is abandoned after a fixed limit, even queued behind the project lock", async () => {
  home();
  await project("alpha", ["one"]);
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const holder = withProjectStateLock("alpha", async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  const logs: string[] = [];
  const started = Date.now();
  await archiveBestEffort("alpha", open(paths.transcript("alpha", "orchestrator")), m => logs.push(m), false, 100);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(logs.join()).toContain("gave up");
  held.resolve(); await holder;
  await Bun.sleep(20);
  expect(existsSync(archivePath()) ? globalRows("SELECT 1 FROM entries WHERE project='alpha'") : []).toEqual([]); // the abandoned job did nothing when it finally got the lock
});
