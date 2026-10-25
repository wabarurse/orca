// SQLite is a rebuildable retrieval index. JSONL and tasks.json remain authoritative.
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config";
import { historicalMessages } from "./image-history";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";
import { allTasks, type Task } from "./tasks";
import { open, type Entry, type Transcript } from "./transcript";

/** One archive for every project, shared by all orchestrator processes. */
export const archivePath = () => paths.memory;
export const transcriptEntries = (t: Transcript): Entry[] => t.all?.() ?? t.history?.() ?? t.branch();
export const contextEpoch = (entries: Entry[]): string => entries.findLast(e => e.type === "context-boundary")?.uuid ?? "initial";

/** Searchable text never indexes reasoning, image bytes or image URLs. Original
 * entries (including scoped image references) are retained losslessly in raw. */
export function entryText(entry: Entry): string {
  if (entry.type === "replies") return entry.messages.map(m => `[${m.from}] ${m.text}`).join("\n");
  if (entry.type !== "message") return "";
  const content = historicalMessages([entry.message])[0]!.content;
  return `[${entry.message.role}] ${typeof content === "string" ? content : JSON.stringify(content)}`;
}

/** A clear starts a fresh scope; old tasks only return when explicitly referenced again. */
export function scopedTasks(tasks: Task[], entries: Entry[]): Task[] {
  const cut = entries.findLastIndex(e => e.type === "context-boundary");
  if (cut < 0) return tasks;
  const mentioned = new Set(entries.slice(cut + 1).flatMap(e => entryText(e).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []));
  return tasks.filter(t => t.createdAt > entries[cut]!.ts || mentioned.has(t.id));
}

/** The only agent whose transcript is ever indexed. Workers and reviewers never reach the database. */
export const ARCHIVE_AGENT = "orchestrator";
const SCHEMA_VERSION = 1;
const BUSY_MS = 10_000;
const TASK_ID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, epoch TEXT NOT NULL, kind TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL, raw TEXT NOT NULL, UNIQUE(project,id));
  CREATE INDEX IF NOT EXISTS entries_scope ON entries(project,agent,epoch);
  CREATE VIRTUAL TABLE IF NOT EXISTS entry_search USING fts5(body, content='entries', content_rowid='rowid');
  CREATE TABLE IF NOT EXISTS tasks (project TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(project,id));
  CREATE TABLE IF NOT EXISTS entry_tasks (project TEXT NOT NULL, entry_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(project,entry_id,task_id));
  CREATE INDEX IF NOT EXISTS entry_tasks_task ON entry_tasks(project,task_id);
  CREATE TABLE IF NOT EXISTS sources (project TEXT NOT NULL, agent TEXT NOT NULL, indexed_through TEXT NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY(project,agent));
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/** The main file and its WAL siblings hold conversation text: owner-only, always. */
function secure(file: string): void {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try { chmodSync(path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
const userVersion = (db: Database): number => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
function initialize(db: Database): void {
  if (userVersion(db) < SCHEMA_VERSION) {
    db.transaction(() => {
      if (userVersion(db) >= SCHEMA_VERSION) return;
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  }
  if (userVersion(db) > SCHEMA_VERSION) throw new Error("memory archive was written by a newer version");
}

/** Open (creating if needed) the one global archive. Many processes share it: WAL plus a long busy timeout. */
export function database(busyMs = BUSY_MS): Database {
  const file = archivePath();
  mkdirSync(dirname(file), { recursive: true });
  closeSync(openSync(file, "a", 0o600)); // never exists with looser permissions, even briefly
  const db = new Database(file, { create: true, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout=${busyMs}`);
    db.exec("PRAGMA journal_mode=WAL");
    initialize(db);
    secure(file);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** The context epoch of each entry: a boundary starts its own epoch. */
export function epochsOf(entries: Entry[]): string[] {
  let epoch = "initial";
  return entries.map(e => e.type === "context-boundary" ? (epoch = e.uuid) : epoch);
}

function insertEntries(db: Database, project: string, entries: Entry[], start: number, taskIds: Set<string>): void {
  const epochs = epochsOf(entries);
  const insert = db.query("INSERT OR IGNORE INTO entries(project,agent,id,epoch,kind,ts,body,raw) VALUES(?,?,?,?,?,?,?,?)");
  const link = db.query("INSERT OR IGNORE INTO entry_tasks(project,entry_id,task_id) VALUES(?,?,?)");
  const search = db.query("INSERT INTO entry_search(rowid,body) VALUES(?,?)");
  for (let i = start; i < entries.length; i++) {
    const e = entries[i]!, body = entryText(e);
    const result = insert.run(project, ARCHIVE_AGENT, e.uuid, epochs[i]!, e.type, e.ts, body, JSON.stringify(e));
    if (result.changes) search.run(result.lastInsertRowid, body);
    // UUIDs are reliable links; branch/agent names can be reused for different tasks.
    for (const id of body.match(TASK_ID) ?? []) if (taskIds.has(id)) link.run(project, e.uuid, id);
  }
}

/** Upsert the registry; returns ids that were not indexed before. */
function upsertTasks(db: Database, project: string, tasks: Task[]): string[] {
  const known = new Set((db.query("SELECT id FROM tasks WHERE project=?").all(project) as { id: string }[]).map(r => r.id));
  const upsert = db.query(`INSERT INTO tasks(project,id,revision,name,summary,branch,status,raw) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET
    revision=excluded.revision,name=excluded.name,summary=excluded.summary,branch=excluded.branch,status=excluded.status,raw=excluded.raw
    WHERE tasks.revision < excluded.revision`);
  for (const t of tasks) upsert.run(project, t.id, t.revision, t.name, t.summary, t.branch, t.archive ? "merged" : t.status, JSON.stringify(t));
  return tasks.filter(t => !known.has(t.id)).map(t => t.id);
}

/** A task first seen now may already be mentioned by entries that were indexed earlier. */
function linkEarlierMentions(db: Database, project: string, ids: string[]): void {
  const link = db.query("INSERT OR IGNORE INTO entry_tasks(project,entry_id,task_id) SELECT project,id,? FROM entries WHERE project=? AND agent=? AND instr(lower(body),lower(?))>0");
  for (const id of ids) link.run(id, project, ARCHIVE_AGENT, id);
}

/** Index one project's orchestrator transcript and registry in a single write transaction. Idempotent.
 * `full` re-checks every entry instead of resuming after the last one indexed (used when migrating). */
export function sync(db: Database, project: string, entries: Entry[], tasks: Task[], full = false): void {
  db.transaction(() => {
    const prior = db.query("SELECT indexed_through FROM sources WHERE project=? AND agent=?").get(project, ARCHIVE_AGENT) as { indexed_through: string } | null;
    // Transcripts only grow; resume after the last entry indexed, or start over if it is no longer in the chain.
    const start = prior && !full ? entries.findIndex(e => e.uuid === prior.indexed_through) + 1 : 0;
    insertEntries(db, project, entries, start, new Set(tasks.map(t => t.id)));
    const added = upsertTasks(db, project, tasks);
    if (start > 0) linkEarlierMentions(db, project, added);
    db.query("INSERT INTO sources(project,agent,indexed_through,indexed_at) VALUES(?,?,?,?) ON CONFLICT(project,agent) DO UPDATE SET indexed_through=excluded.indexed_through,indexed_at=excluded.indexed_at")
      .run(project, ARCHIVE_AGENT, entries.at(-1)?.uuid ?? prior?.indexed_through ?? "", new Date().toISOString());
  }).immediate();
}

/** Archive succeeds before context can be replaced. Safe to repeat after a crash. */
export async function archiveTranscript(project: string, transcript: Transcript, busyMs = BUSY_MS): Promise<Task[]> {
  const identity = projectIdentity(project);
  const tasks = await allTasks(project);
  assertProjectIdentity(project, identity);
  const entries = transcriptEntries(transcript), db = database(busyMs);
  try { sync(db, project, entries, tasks); } finally { db.close(); }
  return scopedTasks(tasks, entries);
}

/** Opportunistic indexing (turn end, /clear). Holds the project state lock while reading, waits a
 * bounded time, and reports failure to `log` instead of throwing: the transcript stays authoritative. */
export async function archiveBestEffort(project: string, transcript: Transcript, log: (message: string) => void, inLock = false): Promise<void> {
  try {
    const identity = projectIdentity(project);
    const index = () => { assertProjectIdentity(project, identity); return archiveTranscript(project, transcript, 2_000); };
    await (inLock ? index() : withProjectStateLock(project, index));
  } catch (error) {
    try { log(`memory index skipped: ${error instanceof Error ? error.message : error}`); } catch { /* logging cannot fail a turn */ }
  }
}

/** Remove every row of a project, including its FTS postings. No-op when no archive exists. */
export function purgeProject(project: string): void {
  if (!existsSync(archivePath())) return;
  const db = database();
  try {
    db.transaction(() => {
      // External-content FTS5 tables are cleared with the special 'delete' command, which needs the original text.
      db.query("INSERT INTO entry_search(entry_search,rowid,body) SELECT 'delete',rowid,body FROM entries WHERE project=?").run(project);
      for (const table of ["entries", "tasks", "entry_tasks", "sources"]) db.query(`DELETE FROM ${table} WHERE project=?`).run(project);
      db.query("DELETE FROM meta WHERE key=?").run(`backfill:${project}`);
    }).immediate();
  } finally { db.close(); }
}

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`expected integer 0..${max}`);
  return value;
}
function queryText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 256) throw new Error("history query must be at most 256 characters");
  return value;
}

/** Bounded, parameterized retrieval; never runs model-supplied SQL or FTS syntax.
 * Scope: this project, the orchestrator's transcript, the current /clear epoch. */
export async function queryHistory(project: string, input: Record<string, unknown>): Promise<string> {
  const identity = projectIdentity(project);
  return withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity);
    return queryLocked(project, input);
  });
}
async function queryLocked(project: string, input: Record<string, unknown>): Promise<string> {
  const transcript = open(paths.transcript(project, "orchestrator"));
  const tasks = await archiveTranscript(project, transcript), epoch = contextEpoch(transcriptEntries(transcript));
  const db = database();
  try {
    return input.action === "read_history" ? readHistory(db, project, epoch, input) : searchHistory(db, project, epoch, tasks, input);
  } finally { db.close(); }
}

function readHistory(db: Database, project: string, epoch: string, input: Record<string, unknown>): string {
  if (typeof input.entryId !== "string") throw new Error("entryId required");
  const offset = integer(input.offset, 0, 100_000_000);
  const row = db.query("SELECT substr(body,?,2048) AS text,length(body) AS length FROM entries WHERE project=? AND agent=? AND id=? AND epoch=? AND body!=''")
    .get(offset + 1, project, ARCHIVE_AGENT, input.entryId, epoch) as { text: string; length: number } | null;
  if (!row) throw new Error("history entry not found in current context scope");
  return JSON.stringify({ entryId: input.entryId, offset, ...row, nextOffset: offset + 2048 < row.length ? offset + 2048 : null, source: "untrusted historical data" });
}

interface Search { words: string[]; limit: number; restrict: boolean; taskIds: Set<string> }
function parseSearch(input: Record<string, unknown>, tasks: Task[]): Search {
  const query = queryText(input.query), limit = Math.max(1, integer(input.limit, 5, 10));
  if (input.status !== undefined && !["all", "merged", "active"].includes(String(input.status))) throw new Error("status must be all, merged or active");
  if (input.taskId !== undefined && typeof input.taskId !== "string") throw new Error("taskId must be text");
  const merged = input.status === "merged", active = input.status === "active";
  const wanted = tasks.filter(t => (!input.taskId || input.taskId === t.id) && (merged ? !!t.archive : active ? !t.archive : true));
  return { words: (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12), limit,
    restrict: input.taskId !== undefined || (input.status !== undefined && input.status !== "all"), taskIds: new Set(wanted.map(t => t.id)) };
}

function searchTasks(db: Database, project: string, { words, limit, taskIds }: Search) {
  const rows = db.query(`SELECT raw FROM tasks WHERE project=? AND id IN (SELECT value FROM json_each(?))
    ${words.map(() => "AND instr(lower(name||' '||summary||' '||branch||' '||id),?)>0").join(" ")}
    ORDER BY rowid DESC LIMIT ?`).all(project, JSON.stringify([...taskIds]), ...words.map(w => w.toLowerCase()), limit) as { raw: string }[];
  return rows.map(({ raw }) => {
    const t = JSON.parse(raw) as Task;
    return { id: t.id, name: t.name, summary: t.summary, branch: t.branch, status: t.archive ? "merged" : t.status, pr: t.pr, attention: t.attention };
  });
}

function searchEntries(db: Database, project: string, epoch: string, { words, limit, restrict, taskIds }: Search) {
  const match = words.map(w => `"${w}"`).join(" AND ");
  const sql = `SELECT e.id AS entryId,e.ts,${match ? "snippet(entry_search,0,'','', ' … ',40)" : "substr(e.body,1,400)"} AS excerpt
    FROM entries e ${match ? "JOIN entry_search ON entry_search.rowid=e.rowid" : ""}
    WHERE e.project=? AND e.agent=? AND e.epoch=? AND e.body!='' ${match ? "AND entry_search MATCH ?" : ""}
    ${restrict ? "AND EXISTS (SELECT 1 FROM entry_tasks l JOIN json_each(?) j ON l.task_id=j.value WHERE l.project=e.project AND l.entry_id=e.id)" : ""}
    ORDER BY ${match ? "rank," : ""} e.rowid DESC LIMIT ?`;
  const params: (string | number)[] = [project, ARCHIVE_AGENT, epoch, ...(match ? [match] : []), ...(restrict ? [JSON.stringify([...taskIds])] : []), limit];
  const rows = db.query(sql).all(...params) as { entryId: string; ts: string; excerpt: string }[];
  return rows.map(r => ({ ...r, excerpt: r.excerpt.slice(0, 400) }));
}

function searchHistory(db: Database, project: string, epoch: string, tasks: Task[], input: Record<string, unknown>): string {
  const search = parseSearch(input, tasks);
  return JSON.stringify({ tasks: searchTasks(db, project, search), entries: searchEntries(db, project, epoch, search), source: "untrusted historical data; task links require an explicit task UUID; use unfiltered text search for unlinked conversations" });
}
