import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteProject } from "./commands";
import { paths, saveConfig } from "./config";
import { archivePath, archiveTranscript, database, purgeProject, queryHistory, taskTimes } from "./memory-archive";
import { createOrchestrator } from "./orchestrator";
import { getTask, observeTaskPR, prepareTaskRun, registerTask, startTaskRun, stopTaskRun, type Task } from "./tasks";
import { fakeProvider, text } from "./test/fake-provider";
import { orchestratorTask } from "./tools/task";
import { open } from "./transcript";

const previous = process.env.ORCA_HOME, dirs: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "memory-global-")); dirs.push(dir); process.env.ORCA_HOME = dir; return dir;
}
const mk = (...projects: string[]) => projects.forEach(p => mkdirSync(paths.project(p), { recursive: true }));
async function say(project: string, role: "user" | "assistant", content: string, agent = "orchestrator") {
  return open(paths.transcript(project, agent)).append({ type: "message", message: { role, content } });
}
const search = async (project: string, query: string, extra = {}) => JSON.parse(await queryHistory(project, { action: "search_history", query, ...extra }));
const rows = <T>(sql: string, ...params: string[]) => {
  const db = new Database(archivePath(), { readonly: true });
  try { return db.query(sql).all(...params) as T[]; } finally { db.close(); }
};

test("two projects share one private file with project and agent columns", async () => {
  const dir = home(); mk("alpha", "beta");
  const a = await say("alpha", "user", "alpha pelican plan"), b = await say("beta", "user", "beta pelican plan");
  await say("beta", "assistant", "beta only walrus");
  const task = await registerTask("alpha", { name: "Alpha task", summary: "pelican", branch: "feat/a", authorized: true });
  await search("alpha", "pelican"); await search("beta", "pelican");
  expect(archivePath()).toBe(join(dir, "memory.sqlite"));
  expect(existsSync(join(paths.project("alpha"), "memory.sqlite"))).toBe(false);
  expect(rows<{ project: string; agent: string; id: string }>("SELECT project,agent,id FROM entries ORDER BY project,rowid").map(r => [r.project, r.agent])).toEqual([["alpha", "orchestrator"], ["beta", "orchestrator"], ["beta", "orchestrator"]]);
  expect(rows<{ id: string }>("SELECT id FROM entries WHERE project='alpha'")).toEqual([{ id: a.uuid }]);
  expect(rows<{ id: string }>("SELECT id FROM entries WHERE project='beta' AND id=?", b.uuid)).toHaveLength(1);
  expect(rows<{ project: string; id: string }>("SELECT project,id FROM tasks")).toEqual([{ project: "alpha", id: task.id }]);
  expect(rows<{ project: string; agent: string }>("SELECT project,agent FROM sources ORDER BY project")).toEqual([{ project: "alpha", agent: "orchestrator" }, { project: "beta", agent: "orchestrator" }]);
  expect(rows<{ user_version: number }>("PRAGMA user_version")).toEqual([{ user_version: 2 }]);
});

const pr = { repository: "o/r", number: 3, url: "https://github.com/o/r/pull/3", head: "a".repeat(40) };
const times = (id: string) => rows<{ started_at: string | null; ended_at: string | null }>("SELECT started_at,ended_at FROM tasks WHERE id=?", id)[0];
/** A registered task, a worker run (prepared, then started unless `start` is false) and optionally a merge. */
async function lifecycle(project: string, { start = true, merge = false } = {}): Promise<Task> {
  const t = await registerTask(project, { name: `Task ${start}${merge}`, summary: "lifecycle", branch: `feat/${start}${merge}`, authorized: true });
  const run = crypto.randomUUID();
  await prepareTaskRun(project, t.id, t.branch, { id: run, agent: "worker", role: "worker" });
  if (start) { await startTaskRun(project, run); await stopTaskRun(project, run, "waiting", "reported"); }
  else await stopTaskRun(project, run, "blocked", "launch failed", true);
  if (merge) await observeTaskPR(project, t.id, { pr, branch: t.branch, state: "MERGED", mergedAt: "2024-05-01T10:00:00.000Z", ready: false, checks: "unknown" });
  return getTask(project, t.id);
}

test("tasks carry started_at (first confirmed run start) and ended_at (confirmed merge), null while active or never started", async () => {
  home(); mk("alpha");
  const active = await lifecycle("alpha"), merged = await lifecycle("alpha", { merge: true }), unstarted = await lifecycle("alpha", { start: false });
  await say("alpha", "user", "indexing trigger");
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  const [a, m, u] = [times(active.id)!, times(merged.id)!, times(unstarted.id)!];
  expect(a).toEqual({ started_at: active.runs[0]!.startedAt!, ended_at: null });
  expect(m).toEqual({ started_at: merged.runs[0]!.startedAt!, ended_at: "2024-05-01T10:00:00.000Z" });
  expect(u).toEqual({ started_at: null, ended_at: null });
  expect(unstarted.runs[0]!.state).toBe("failed"); expect(unstarted.attention?.kind).toBe("blocked");
  // A cancelled run is revocable attention, not an end.
  const later = crypto.randomUUID();
  await prepareTaskRun("alpha", active.id, active.branch, { id: later, agent: "worker", role: "worker" });
  await startTaskRun("alpha", later); await stopTaskRun("alpha", later, "cancelled", "stopped by user");
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  expect(times(active.id)).toEqual(a);
  expect(taskTimes({ runs: [{ startedAt: "2024-02-01T00:00:00.000Z" }, { startedAt: "2024-01-01T00:00:00.000Z" }] } as Task)).toEqual({ startedAt: "2024-01-01T00:00:00.000Z", endedAt: null });
});

test("a version-1 archive gains the task time columns in place, filled from each row's raw record", async () => {
  home(); mk("alpha");
  const db = new Database(archivePath(), { create: true, strict: true });
  db.exec(`CREATE TABLE tasks (project TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(project,id)); PRAGMA user_version=1`);
  const raw = (runs: object[], archive?: object) => JSON.stringify({ runs, ...(archive ? { archive } : {}) });
  db.query("INSERT INTO tasks VALUES('alpha','merged',3,'n','s','b','merged',?)").run(raw([{ preparedAt: "2024-01-01T00:00:00.000Z" }, { startedAt: "2024-01-02T00:00:00.000Z" }], { reason: "merged", mergedAt: "2024-01-03T00:00:00.000Z" }));
  db.query("INSERT INTO tasks VALUES('alpha','open',1,'n','s','b','queued',?)").run(raw([]));
  db.query("INSERT INTO tasks VALUES('alpha','broken',1,'n','s','b','queued','not json')").run();
  db.close();
  database().close();
  expect(rows<{ user_version: number }>("PRAGMA user_version")).toEqual([{ user_version: 2 }]);
  expect(rows("SELECT id,started_at,ended_at FROM tasks ORDER BY id")).toEqual([
    { id: "broken", started_at: null, ended_at: null },
    { id: "merged", started_at: "2024-01-02T00:00:00.000Z", ended_at: "2024-01-03T00:00:00.000Z" },
    { id: "open", started_at: null, ended_at: null }]);
  // Re-indexing an existing row that gained a revision updates the times too.
  const t = await lifecycle("alpha", { merge: true });
  await say("alpha", "user", "hello");
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  expect(times(t.id)).toEqual({ started_at: t.runs[0]!.startedAt!, ended_at: "2024-05-01T10:00:00.000Z" });
  database().close(); // already current: no second upgrade
  expect(rows("SELECT count(*) AS n FROM tasks")).toEqual([{ n: 4 }]);
});

test("the file and its WAL siblings are owner-only", async () => {
  home(); await say("alpha", "user", "secret plan");
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  const db = database();
  try {
    db.exec("INSERT INTO meta(key,value) VALUES('probe','1')");
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = archivePath() + suffix;
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  } finally { db.close(); }
});

test("task search_history stays scoped to project and epoch; other projects' rows change nothing", async () => {
  home();
  const first = await say("alpha", "user", "needle in alpha before clear");
  const query = { action: "search_history", query: "needle" };
  const ctx = { project: "alpha", role: "orchestrator" as const, cwd: "/" };
  const before = JSON.parse(await orchestratorTask.run(query, ctx));
  expect(before.entries.map((e: { entryId: string }) => e.entryId)).toEqual([first.uuid]);
  const other = await say("beta", "user", "needle needle needle in beta");
  await search("beta", "needle");
  expect(JSON.parse(await orchestratorTask.run(query, ctx))).toEqual(before);
  await expect(queryHistory("alpha", { action: "read_history", entryId: other.uuid })).rejects.toThrow("current context");
  expect(JSON.parse(await queryHistory("beta", { action: "read_history", entryId: other.uuid })).text).toContain("in beta");
  await open(paths.transcript("alpha", "orchestrator")).append({ type: "context-boundary" });
  const fresh = await say("alpha", "user", "needle after clear");
  expect((await search("alpha", "needle")).entries.map((e: { entryId: string }) => e.entryId)).toEqual([fresh.uuid]);
  await expect(queryHistory("alpha", { action: "read_history", entryId: first.uuid })).rejects.toThrow("current context");
  expect((await search("beta", "needle")).entries.map((e: { entryId: string }) => e.entryId)).toEqual([other.uuid]);
});

test("task links are per project even when two projects mention the same task uuid", async () => {
  home();
  const id = crypto.randomUUID(); mk("alpha", "beta");
  await registerTask("alpha", { id, name: "Shared id", summary: "alpha copy", branch: "feat/s", authorized: true });
  await registerTask("beta", { id, name: "Shared id", summary: "beta copy", branch: "feat/s", authorized: true });
  const a = await say("alpha", "user", `work on ${id}`), b = await say("beta", "user", `work on ${id}`);
  const found = async (project: string) => (await search(project, "", { taskId: id })).entries.map((e: { entryId: string }) => e.entryId);
  expect(await found("alpha")).toEqual([a.uuid]); expect(await found("beta")).toEqual([b.uuid]);
});

test("deleting the database and its siblings loses nothing: results are identical after rebuild", async () => {
  home(); mk("alpha", "beta");
  const t = await registerTask("alpha", { name: "Rebuild me", summary: "walrus work", branch: "feat/r", authorized: true });
  await say("alpha", "user", `walrus ${t.id} alpha`); await say("beta", "user", "walrus beta");
  const q = { status: "all", limit: 10 };
  const [a, b] = [await search("alpha", "walrus", q), await search("beta", "walrus", q)];
  for (const suffix of ["", "-wal", "-shm"]) rmSync(archivePath() + suffix, { force: true });
  expect(await search("alpha", "walrus", q)).toEqual(a); expect(await search("beta", "walrus", q)).toEqual(b);
  expect(a.entries).toHaveLength(1);
});

test("incremental indexing resumes after the last indexed entry and never duplicates", async () => {
  home();
  const transcript = open(paths.transcript("alpha", "orchestrator"));
  await say("alpha", "user", "one"); await archiveTranscript("alpha", transcript);
  await say("alpha", "assistant", "two"); const fresh = open(paths.transcript("alpha", "orchestrator"));
  await archiveTranscript("alpha", fresh); await archiveTranscript("alpha", fresh);
  expect(rows<{ body: string }>("SELECT body FROM entries WHERE project='alpha' ORDER BY rowid").map(r => r.body)).toEqual(["[user] one", "[assistant] two"]);
  expect(rows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'two'")).toHaveLength(1);
});

test("a task registered after its mention still links to the earlier entry", async () => {
  home();
  const id = crypto.randomUUID(); mk("alpha");
  const entry = await say("alpha", "user", `plan for ${id}`);
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  await registerTask("alpha", { id, name: "Late task", summary: "registered late", branch: "feat/late", authorized: true });
  await say("alpha", "user", "another message");
  await archiveTranscript("alpha", open(paths.transcript("alpha", "orchestrator")));
  expect((await search("alpha", "", { taskId: id })).entries.map((e: { entryId: string }) => e.entryId)).toEqual([entry.uuid]);
});

test("worker and reviewer transcripts are never indexed", async () => {
  home();
  await say("alpha", "user", "orchestrator words");
  await say("alpha", "assistant", "WORKER_SECRET", "worker-feat-x");
  await say("alpha", "assistant", "REVIEWER_SECRET", "reviewer-feat-x");
  await search("alpha", "WORKER_SECRET");
  const { backfillMemory } = await import("./memory-backfill");
  expect(await backfillMemory()).toBe(true);
  expect(rows<{ agent: string }>("SELECT DISTINCT agent FROM entries")).toEqual([{ agent: "orchestrator" }]);
  expect(rows("SELECT 1 FROM entries WHERE body LIKE '%SECRET%' OR raw LIKE '%SECRET%'")).toEqual([]);
  expect((await search("alpha", "WORKER_SECRET")).entries).toEqual([]);
  expect((await search("alpha", "REVIEWER_SECRET")).entries).toEqual([]);
});

test("injection-style queries stay inert in the shared database", async () => {
  home();
  await say("alpha", "user", "ordinary text"); await say("beta", "user", "other project text");
  for (const query of ["\" OR 1=1; --", "* NEAR(a b) -x", "text') ; DROP TABLE entries; --", "project:beta"]) {
    expect((await search("alpha", query)).entries.every((e: { excerpt: string }) => !e.excerpt.includes("other project"))).toBe(true);
  }
  await search("beta", "text");
  expect(rows<{ n: number }>("SELECT count(*) AS n FROM entries")[0]!.n).toBe(2);
  expect((await search("alpha", "other")).entries).toEqual([]);
});

test("project delete purges the project's rows, FTS postings included, and keeps the others", async () => {
  const dir = home();
  mkdirSync(join(dir, "projects", "gone", "inbox"), { recursive: true });
  const t = await registerTask("gone", { name: "Doomed", summary: "walrus", branch: "feat/d", authorized: true });
  await say("gone", "user", `walrus ${t.id} doomed`); await say("kept", "user", "walrus survivor");
  await search("gone", "walrus"); await search("kept", "walrus");
  expect(rows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(2);
  await deleteProject("gone", { live: async () => [], kill: async () => {} });
  expect(existsSync(paths.project("gone"))).toBe(false);
  for (const table of ["entries", "tasks", "entry_tasks", "sources"]) expect(rows(`SELECT 1 FROM ${table} WHERE project='gone'`)).toEqual([]);
  expect(rows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'walrus'")).toHaveLength(1);
  const db = database();
  try { db.exec("INSERT INTO entry_search(entry_search) VALUES('integrity-check')"); } finally { db.close(); }
  expect((await search("kept", "walrus")).entries).toHaveLength(1);
});

test("project delete still succeeds when the archive cannot be purged", async () => {
  const dir = home();
  mkdirSync(join(dir, "projects", "gone"), { recursive: true });
  mkdirSync(archivePath()); // unusable archive
  await deleteProject("gone", { live: async () => [], kill: async () => {} });
  expect(existsSync(paths.project("gone"))).toBe(false);
  expect(() => purgeProject("gone")).toThrow();
});

test("a turn indexes the orchestrator transcript; an unusable archive never fails the turn", async () => {
  const dir = home(); await saveConfig({ model: "unknown", compact: false });
  const transcript = open(paths.transcript("alpha", "orchestrator"));
  const logs: string[] = [];
  const orch = await createOrchestrator({ project: "alpha", transcript, provider: fakeProvider([[text("noted")], [text("second")]]), tools: {}, write: s => { logs.push(s); } });
  await orch.say("hello archive"); await orch.turn();
  expect(rows<{ body: string }>("SELECT body FROM entries WHERE project='alpha' ORDER BY rowid").map(r => r.body).join("\n")).toContain("hello archive");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(archivePath() + suffix, { force: true });
  mkdirSync(archivePath());
  await orch.say("still works"); await orch.turn();
  expect(transcript.branch().some(e => e.type === "message" && JSON.stringify(e.message).includes("still works"))).toBe(true);
  expect(logs.join("")).toContain("memory index skipped");
  orch.dispose?.(); void dir;
});

test("concurrent processes archiving different projects lose no rows", async () => {
  const dir = home();
  const projects = ["p1", "p2", "p3", "p4"];
  for (const p of projects) for (let i = 0; i < 40; i++) await say(p, i % 2 ? "assistant" : "user", `${p} message ${i}`);
  const script = join(dir, "worker.ts"), module = join(import.meta.dir, "memory-archive.ts"), transcripts = join(import.meta.dir, "transcript.ts"), cfg = join(import.meta.dir, "config.ts");
  writeFileSync(script, `import { archiveTranscript } from ${JSON.stringify(module)};
import { open } from ${JSON.stringify(transcripts)};
import { paths } from ${JSON.stringify(cfg)};
const project = process.argv[2]!;
for (let round = 0; round < 5; round++) await archiveTranscript(project, open(paths.transcript(project, "orchestrator")));`);
  const procs = projects.map(p => Bun.spawn(["bun", script, p], { env: { ...process.env, ORCA_HOME: dir }, stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(procs.map(async p => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
  expect(results.map(r => r.code), results.map(r => r.err).join()).toEqual([0, 0, 0, 0]);
  for (const p of projects) expect(rows<{ n: number }>("SELECT count(*) AS n FROM entries WHERE project=?", p)[0]!.n).toBe(40);
  expect(rows("SELECT rowid FROM entry_search WHERE entry_search MATCH 'message'")).toHaveLength(160);
}, 60_000);
