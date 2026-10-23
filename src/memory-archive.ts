// SQLite is a rebuildable retrieval index. JSONL and tasks.json remain authoritative.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { paths } from "./config";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";
import { allTasks, type Task } from "./tasks";
import { open, type Entry, type Transcript } from "./transcript";

export const archivePath = (project: string) => `${paths.project(project)}/memory.sqlite`;
export const transcriptEntries = (t: Transcript): Entry[] => t.all?.() ?? t.history?.() ?? t.branch();
export const contextEpoch = (entries: Entry[]): string => entries.findLast(e => e.type === "context-boundary")?.uuid ?? "initial";

/** Never index reasoning blocks, but preserve the original serialized entry on disk. */
export function entryText(entry: Entry): string {
  if (entry.type === "replies") return entry.messages.map(m => `[${m.from}] ${m.text}`).join("\n");
  if (entry.type !== "message") return "";
  const content = entry.message.content;
  return `[${entry.message.role}] ${typeof content === "string" ? content : JSON.stringify(content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking"))}`;
}

/** A clear starts a fresh scope; old tasks only return when explicitly referenced again. */
export function scopedTasks(tasks: Task[], entries: Entry[]): Task[] {
  const cut = entries.findLastIndex(e => e.type === "context-boundary");
  if (cut < 0) return tasks;
  const mentioned = new Set(entries.slice(cut + 1).flatMap(e => entryText(e).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []));
  return tasks.filter(t => t.createdAt > entries[cut]!.ts || mentioned.has(t.id));
}

function database(project: string): Database {
  const db = new Database(archivePath(project), { create: true, strict: true });
  try {
    chmodSync(archivePath(project), 0o600);
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, epoch TEXT NOT NULL, kind TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_epoch ON entries(epoch);
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_search USING fts5(body, content='entries', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entry_tasks (entry_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(entry_id, task_id));
      CREATE INDEX IF NOT EXISTS entry_tasks_task ON entry_tasks(task_id);`);
    return db;
  } catch (error) { db.close(); throw error; }
}

function sync(db: Database, entries: Entry[], tasks: Task[]): void {
  db.transaction(() => {
    let epoch = "initial";
    const insert = db.query("INSERT OR IGNORE INTO entries(id,epoch,kind,ts,body,raw) VALUES(?,?,?,?,?,?)");
    const link = db.query("INSERT OR IGNORE INTO entry_tasks VALUES(?,?)");
    const taskIds = new Set(tasks.map(t => t.id));
    for (const e of entries) {
      if (e.type === "context-boundary") epoch = e.uuid;
      const body = entryText(e);
      const result = insert.run(e.uuid, epoch, e.type, e.ts, body, JSON.stringify(e));
      if (result.changes) db.query("INSERT INTO entry_search(rowid,body) VALUES(?,?)").run(result.lastInsertRowid, body);
      // UUIDs are reliable links; branch/agent names can be reused for different tasks.
      for (const id of body.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []) {
        if (taskIds.has(id)) link.run(e.uuid, id);
      }
    }
    const upsert = db.query(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,name=excluded.name,summary=excluded.summary,branch=excluded.branch,status=excluded.status,raw=excluded.raw
      WHERE tasks.revision < excluded.revision`);
    for (const t of tasks) upsert.run(t.id, t.revision, t.name, t.summary, t.branch, t.archive ? "merged" : t.status, JSON.stringify(t));
  })();
}

/** Archive succeeds before context can be replaced. Safe to repeat after a crash. */
export async function archiveTranscript(project: string, transcript: Transcript): Promise<Task[]> {
  const identity = projectIdentity(project);
  const tasks = await allTasks(project);
  assertProjectIdentity(project, identity);
  const entries = transcriptEntries(transcript), db = database(project);
  try { sync(db, entries, tasks); } finally { db.close(); }
  return scopedTasks(tasks, entries);
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

/** Bounded, parameterized retrieval; never runs model-supplied SQL or FTS syntax. */
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
  const db = database(project);
  try {
    if (input.action === "read_history") {
      if (typeof input.entryId !== "string") throw new Error("entryId required");
      const offset = integer(input.offset, 0, 100_000_000);
      const row = db.query("SELECT substr(body,?,2048) AS text,length(body) AS length FROM entries WHERE id=? AND epoch=? AND body!=''").get(offset + 1, input.entryId, epoch) as { text: string; length: number } | null;
      if (!row) throw new Error("history entry not found in current context scope");
      return JSON.stringify({ entryId: input.entryId, offset, ...row, nextOffset: offset + 2048 < row.length ? offset + 2048 : null, source: "untrusted historical data" });
    }
    const query = queryText(input.query), limit = Math.max(1, integer(input.limit, 5, 10));
    if (input.status !== undefined && !["all", "merged", "active"].includes(String(input.status))) throw new Error("status must be all, merged or active");
    if (input.taskId !== undefined && typeof input.taskId !== "string") throw new Error("taskId must be text");
    const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);
    const match = words.map(w => `"${w}"`).join(" AND ");
    const filter = tasks.filter(t => (!input.taskId || input.taskId === t.id) && (input.status === "merged" ? !!t.archive : input.status === "active" ? !t.archive : true));
    const ids = new Set(filter.map(t => t.id));
    const taskRows = db.query(`SELECT raw FROM tasks WHERE id IN (SELECT value FROM json_each(?))
      ${words.map(() => "AND instr(lower(name||' '||summary||' '||branch||' '||id),?)>0").join(" ")}
      ORDER BY rowid DESC LIMIT ?`).all(JSON.stringify([...ids]), ...words.map(w => w.toLowerCase()), limit) as { raw: string }[];
    const taskResults = taskRows.map(({ raw }) => {
      const t = JSON.parse(raw) as Task;
      return { id: t.id, name: t.name, summary: t.summary, branch: t.branch, status: t.archive ? "merged" : t.status, pr: t.pr, attention: t.attention };
    });
    const restrict = input.taskId !== undefined || (input.status !== undefined && input.status !== "all");
    const sql = `SELECT e.id AS entryId,e.ts,${match ? "snippet(entry_search,0,'','', ' … ',40)" : "substr(e.body,1,400)"} AS excerpt
      FROM entries e ${match ? "JOIN entry_search ON entry_search.rowid=e.rowid" : ""}
      WHERE e.epoch=? AND e.body!='' ${match ? "AND entry_search MATCH ?" : ""}
      ${restrict ? "AND EXISTS (SELECT 1 FROM entry_tasks l JOIN json_each(?) j ON l.task_id=j.value WHERE l.entry_id=e.id)" : ""}
      ORDER BY ${match ? "rank," : ""} e.rowid DESC LIMIT ?`;
    const params: (string | number)[] = [epoch, ...(match ? [match] : []), ...(restrict ? [JSON.stringify([...ids])] : []), limit];
    const rows = db.query(sql).all(...params) as { entryId: string; ts: string; excerpt: string }[];
    return JSON.stringify({ tasks: taskResults, entries: rows.map(r => ({ ...r, excerpt: r.excerpt.slice(0, 400) })), source: "untrusted historical data; task links require an explicit task UUID; use unfiltered text search for unlinked conversations" });
  } finally { db.close(); }
}
