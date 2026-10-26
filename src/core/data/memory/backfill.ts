// One-time, resumable migration from per-project memory.sqlite files to the global archive.
//
// The transcript and tasks.json are authoritative; the old file is only an index. It is deleted
// after, and only after, the project was re-indexed into the global database and read back
// identically. Anything short of that keeps the old file and is retried on a later start.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "../../../config/config";
import { ARCHIVE_AGENT, BATCH, database, entryText, epochsOf, purgeProject, sync, transcriptEntries } from "./archive";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "../projects/state";
import { allTasks, type Task } from "../tasks/tasks";
import { open, type Entry } from "../transcripts/transcript";

export const BACKFILL_VERSION = "1";
const VALID_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BackfillOptions {
  /** Reports a failure or skipped project; never throws into the caller. */
  log?: (message: string) => void;
  /** Test seam: runs after a project is indexed and before it is verified. */
  afterIndex?: (project: string, db: Database) => void;
  /** Stops the work between projects and batches (session disposed, process leaving). Locks are released on the way out. */
  signal?: AbortSignal;
}

interface Snapshot { entries: Entry[]; tasks: Task[] }

const oldFiles = (project: string): string[] => {
  const base = `${paths.project(project)}/memory.sqlite`;
  return [base, `${base}-wal`, `${base}-shm`, `${base}-journal`];
};
const metaKey = (project: string) => `backfill:${project}`;
const getMeta = (db: Database, key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value;
const setMeta = (db: Database, key: string, value: string) => { db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); };

function readTranscript(project: string): Entry[] {
  const path = paths.transcript(project, ARCHIVE_AGENT);
  return existsSync(path) ? transcriptEntries(open(path)) : [];
}
async function snapshot(project: string): Promise<Snapshot> {
  // Throws (and so keeps the old file) when either source cannot be read.
  return { tasks: await allTasks(project), entries: readTranscript(project) };
}

type Row = { id: string; epoch: string; body: string; raw: string };
/** Yield the event loop every BATCH items, and stop when aborted. */
async function pace(i: number, signal?: AbortSignal): Promise<void> {
  if (i % BATCH !== BATCH - 1) return;
  signal?.throwIfAborted();
  await Bun.sleep(0);
}
async function differing(rows: Map<string, Row>, entries: Entry[], signal?: AbortSignal): Promise<string | undefined> {
  const epochs = epochsOf(entries);
  for (const [i, e] of entries.entries()) {
    const row = rows.get(e.uuid);
    if (!row) return `entry ${e.uuid} missing`;
    if (row.body !== entryText(e) || row.raw !== JSON.stringify(e) || row.epoch !== epochs[i]) return `entry ${e.uuid} differs`;
    await pace(i, signal);
  }
}
function staleTask(db: Database, project: string, tasks: Task[]): string | undefined {
  const revision = db.query("SELECT revision FROM tasks WHERE project=? AND id=?");
  for (const t of tasks) {
    const row = revision.get(project, t.id) as { revision: number } | null;
    if (!row || row.revision < t.revision) return `task ${t.id} missing or stale`;
  }
}

/** Why the global database does not faithfully hold this snapshot, or undefined when it does. */
async function mismatch(db: Database, project: string, { entries, tasks }: Snapshot, fresh: Set<string>, signal?: AbortSignal): Promise<string | undefined> {
  const rows = new Map((db.query("SELECT id,epoch,body,raw FROM entries WHERE project=? AND agent=?").all(project, ARCHIVE_AGENT) as Row[]).map(r => [r.id, r]));
  const problem = await differing(rows, entries, signal);
  if (problem) return problem;
  // Entries appended to the transcript while we worked are fine; anything else extra is not.
  const known = new Set(entries.map(e => e.uuid));
  const extra = [...rows.keys()].filter(id => !known.has(id));
  if (extra.some(id => !fresh.has(id))) return "indexed entries absent from the transcript";
  if (rows.size - extra.length !== entries.length) return "entry counts differ";
  return staleTask(db, project, tasks);
}

const NOT_A_DATABASE = new Set(["SQLITE_NOTADB", "SQLITE_CORRUPT"]);
/** Only "this file is not a usable SQLite database" means there is nothing to preserve; busy, I/O and read-only errors do not. */
function notADatabase(error: unknown): boolean {
  return NOT_A_DATABASE.has(String((error as { code?: unknown })?.code));
}

/** Rows the old per-project index holds that the global one does not (it may be the only copy).
 * Copy and I/O failures propagate (the old file is kept); an empty or non-database file has nothing to preserve. */
async function unmigrated(db: Database, project: string, signal?: AbortSignal): Promise<string | undefined> {
  const file = oldFiles(project)[0]!;
  if (!existsSync(file)) return;
  if (statSync(file).size === 0) return;
  // Read a private copy of the main file alone: leftover -wal/-journal siblings must not make the read fail or write.
  const scratch = mkdtempSync(join(paths.root, ".backfill-"));
  try {
    const copy = join(scratch, "old.sqlite");
    copyFileSync(file, copy);
    let old: Database;
    try { old = new Database(copy, { readonly: true, strict: true }); }
    catch (error) { if (notADatabase(error)) return; throw error; }
    try { return await missingFrom(db, project, old, signal); }
    catch (error) { if (notADatabase(error)) return; throw error; }
    finally { old.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
async function missingFrom(db: Database, project: string, old: Database, signal?: AbortSignal): Promise<string | undefined> {
  const tables = new Set((old.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
  const entry = db.query("SELECT 1 FROM entries WHERE project=? AND id=?");
  const ids = tables.has("entries") ? old.query("SELECT id FROM entries").all() as { id: string }[] : [];
  for (const [i, { id }] of ids.entries()) {
    if (!entry.get(project, id)) return `old index has entry ${id} that the transcript no longer yields`;
    await pace(i, signal);
  }
  const task = db.query("SELECT revision FROM tasks WHERE project=? AND id=?");
  const oldTasks = tables.has("tasks") ? old.query("SELECT id,revision FROM tasks").all() as { id: string; revision: number }[] : [];
  for (const t of oldTasks) {
    const row = task.get(project, t.id) as { revision: number } | null;
    if (!row || row.revision < t.revision) return `old index has task ${t.id} that tasks.json no longer yields`;
  }
}

async function removeOld(project: string): Promise<void> {
  for (const file of oldFiles(project)) await rm(file, { force: true });
}

/** Under the project's state lock: index, verify, then delete the old files. False means retry later. */
async function migrateLocked(project: string, options: BackfillOptions): Promise<boolean> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!existsSync(paths.project(project))) return true;
  const db = database();
  try {
    if (getMeta(db, metaKey(project)) && !oldFiles(project).some(existsSync)) return true;
    const identity = projectIdentity(project), source = await snapshot(project);
    assertProjectIdentity(project, identity);
    await sync(db, project, source.entries, source.tasks, { full: true, signal });
    options.afterIndex?.(project, db);
    const fresh = new Set(readTranscript(project).map(e => e.uuid));
    const problem = await mismatch(db, project, source, fresh, signal) ?? await unmigrated(db, project, signal);
    if (problem) { options.log?.(`memory backfill kept the old index of ${project}: ${problem}`); return false; }
    signal?.throwIfAborted();
    await removeOld(project);
    setMeta(db, metaKey(project), new Date().toISOString());
    return true;
  } finally { db.close(); }
}

/** Returns false when the project must be retried on a later start; never throws. */
async function migrateProject(project: string, options: BackfillOptions): Promise<boolean> {
  try { return await withProjectStateLock(project, () => migrateLocked(project, options)); }
  catch (error) {
    if (options.signal?.aborted) return false; // leaving, not failing
    try { options.log?.(`memory backfill of ${project} failed; will retry: ${error instanceof Error ? error.message : error}`); } catch { /* best effort */ }
    return false;
  }
}

function projectFolders(): string[] {
  try {
    return readdirSync(dirname(paths.project("x")), { withFileTypes: true }).filter(d => d.isDirectory() && VALID_PROJECT.test(d.name)).map(d => d.name);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Projects with rows (or a backfill mark) whose folder is gone: deleted while the archive was unavailable,
 * purged unsuccessfully, or re-indexed by another process just after deletion. `sources` has a row for
 * every indexed project (written in the same transactions as its entries), so this is a small scan. */
export function orphanProjects(db: Database): string[] {
  const seen = db.query(`SELECT project FROM sources UNION SELECT project FROM tasks UNION SELECT substr(key,10) FROM meta WHERE key LIKE 'backfill:%'`).all() as { project: string }[];
  return seen.map(r => r.project).filter(project => !existsSync(paths.project(project)));
}

/** Remove orphaned projects' rows. Runs on every start, independent of the migration. */
export function cleanOrphans(): void {
  const db = database();
  let orphans: string[];
  try { orphans = orphanProjects(db); } finally { db.close(); }
  for (const project of orphans) purgeProject(project);
}

async function migrateAll(options: BackfillOptions): Promise<boolean> {
  let complete = true;
  for (const project of projectFolders()) {
    options.signal?.throwIfAborted();
    await Bun.sleep(0); // yield: the foreground keeps running between projects
    complete = await migrateProject(project, options) && complete;
  }
  return complete;
}

/** Resumable: returns true when every project is migrated, false when some must be retried on a later start.
 * Orphan cleanup is separate from, and not gated by, the migration's completion mark. */
export async function backfillMemory(options: BackfillOptions = {}): Promise<boolean> {
  const db = database();
  let done: boolean;
  try { done = getMeta(db, "backfill_version") === BACKFILL_VERSION; } finally { db.close(); }
  const complete = done || await migrateAll(options);
  options.signal?.throwIfAborted();
  cleanOrphans();
  if (complete && !done) {
    const after = database();
    try { setMeta(after, "backfill_version", BACKFILL_VERSION); } finally { after.close(); }
  }
  return complete;
}

interface Run { promise: Promise<boolean>; abort: AbortController; owners: number }
const started = new Map<string, Run>();

function launch(options: BackfillOptions): Run {
  const abort = new AbortController();
  const promise = backfillMemory({ ...options, signal: abort.signal }).catch(error => {
    if (!abort.signal.aborted) report(options, `memory backfill failed; will retry on a later start: ${error instanceof Error ? error.message : error}`);
    return false;
  });
  return { promise, abort, owners: 0 };
}
function report(options: BackfillOptions, message: string): void {
  try { options.log?.(message); } catch { /* best effort */ }
}
/** The run stops once every session that started or joined it has aborted. */
function retain(run: Run, signal: AbortSignal): void {
  run.owners++;
  const release = () => { if (--run.owners === 0) run.abort.abort(new Error("memory backfill stopped")); };
  if (signal.aborted) release(); else signal.addEventListener("abort", release, { once: true });
}

/** Fire-and-forget from startup, once per process and archive. Never rejects, never blocks the caller.
 * The work stops when every caller's `signal` has aborted (all sessions disposed), so it cannot outlive
 * the sessions or leave a project lock behind at exit. */
export function startMemoryBackfill(options: BackfillOptions = {}): Promise<boolean> {
  const key = paths.memory;
  let run = started.get(key);
  if (!run || run.abort.signal.aborted) run = launch(options); // a stopped run is replaced, not reused
  started.set(key, run);
  if (options.signal) retain(run, options.signal);
  return run.promise;
}
