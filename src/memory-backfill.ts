// One-time, resumable migration from per-project memory.sqlite files to the global archive.
//
// The transcript and tasks.json are authoritative; the old file is only an index. It is deleted
// after, and only after, the project was re-indexed into the global database and read back
// identically. Anything short of that keeps the old file and is retried on a later start.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "./config";
import { ARCHIVE_AGENT, database, entryText, epochsOf, purgeProject, sync, transcriptEntries } from "./memory-archive";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";
import { allTasks, type Task } from "./tasks";
import { open, type Entry } from "./transcript";

export const BACKFILL_VERSION = "1";
const VALID_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BackfillOptions {
  /** Reports a failure or skipped project; never throws into the caller. */
  log?: (message: string) => void;
  /** Test seam: runs after a project is indexed and before it is verified. */
  afterIndex?: (project: string, db: Database) => void;
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
function differing(rows: Map<string, Row>, entries: Entry[]): string | undefined {
  const epochs = epochsOf(entries);
  for (const [i, e] of entries.entries()) {
    const row = rows.get(e.uuid);
    if (!row) return `entry ${e.uuid} missing`;
    if (row.body !== entryText(e) || row.raw !== JSON.stringify(e) || row.epoch !== epochs[i]) return `entry ${e.uuid} differs`;
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
function mismatch(db: Database, project: string, { entries, tasks }: Snapshot, fresh: Set<string>): string | undefined {
  const rows = new Map((db.query("SELECT id,epoch,body,raw FROM entries WHERE project=? AND agent=?").all(project, ARCHIVE_AGENT) as Row[]).map(r => [r.id, r]));
  const problem = differing(rows, entries);
  if (problem) return problem;
  // Entries appended to the transcript while we worked are fine; anything else extra is not.
  const known = new Set(entries.map(e => e.uuid));
  const extra = [...rows.keys()].filter(id => !known.has(id));
  if (extra.some(id => !fresh.has(id))) return "indexed entries absent from the transcript";
  if (rows.size - extra.length !== entries.length) return "entry counts differ";
  return staleTask(db, project, tasks);
}

/** Rows the old per-project index holds that the global one does not (it may be the only copy). */
function unmigrated(db: Database, project: string): string | undefined {
  const file = oldFiles(project)[0]!;
  if (!existsSync(file)) return;
  // Read a private copy of the main file alone: leftover -wal/-journal siblings must not make the read fail or write.
  const scratch = mkdtempSync(join(paths.root, ".backfill-"));
  try {
    copyFileSync(file, join(scratch, "old.sqlite"));
    const old = new Database(join(scratch, "old.sqlite"), { readonly: true, strict: true });
    try { return missingFrom(db, project, old); } finally { old.close(); }
  } catch { /* not a readable index: nothing in it to preserve */ }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
function missingFrom(db: Database, project: string, old: Database): string | undefined {
  const entry = db.query("SELECT 1 FROM entries WHERE project=? AND id=?");
  for (const { id } of old.query("SELECT id FROM entries").all() as { id: string }[]) {
    if (!entry.get(project, id)) return `old index has entry ${id} that the transcript no longer yields`;
  }
  const task = db.query("SELECT revision FROM tasks WHERE project=? AND id=?");
  for (const t of old.query("SELECT id,revision FROM tasks").all() as { id: string; revision: number }[]) {
    const row = task.get(project, t.id) as { revision: number } | null;
    if (!row || row.revision < t.revision) return `old index has task ${t.id} that tasks.json no longer yields`;
  }
}

async function removeOld(project: string): Promise<void> {
  for (const file of oldFiles(project)) await rm(file, { force: true });
}

/** Under the project's state lock: index, verify, then delete the old files. False means retry later. */
async function migrateLocked(project: string, options: BackfillOptions): Promise<boolean> {
  if (!existsSync(paths.project(project))) return true;
  const db = database();
  try {
    if (getMeta(db, metaKey(project)) && !oldFiles(project).some(existsSync)) return true;
    const identity = projectIdentity(project), source = await snapshot(project);
    assertProjectIdentity(project, identity);
    sync(db, project, source.entries, source.tasks, true);
    options.afterIndex?.(project, db);
    const problem = mismatch(db, project, source, new Set(readTranscript(project).map(e => e.uuid))) ?? unmigrated(db, project);
    if (problem) { options.log?.(`memory backfill kept the old index of ${project}: ${problem}`); return false; }
    await removeOld(project);
    setMeta(db, metaKey(project), new Date().toISOString());
    return true;
  } finally { db.close(); }
}

/** Returns false when the project must be retried on a later start; never throws. */
async function migrateProject(project: string, options: BackfillOptions): Promise<boolean> {
  try { return await withProjectStateLock(project, () => migrateLocked(project, options)); }
  catch (error) {
    try { options.log?.(`memory backfill of ${project} failed; will retry: ${error instanceof Error ? error.message : error}`); } catch { /* best effort */ }
    return false;
  }
}

function projectFolders(): string[] {
  try {
    return readdirSync(dirname(paths.project("x")), { withFileTypes: true }).filter(d => d.isDirectory() && VALID_PROJECT.test(d.name)).map(d => d.name);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Projects with rows (or a backfill mark) whose folder is gone: deleted while the archive was unavailable, or by an older build. */
export function orphanProjects(db: Database): string[] {
  const seen = db.query(`SELECT project FROM sources UNION SELECT project FROM entries UNION SELECT project FROM tasks UNION SELECT project FROM entry_tasks
    UNION SELECT substr(key,10) FROM meta WHERE key LIKE 'backfill:%'`).all() as { project: string }[];
  return seen.map(r => r.project).filter(project => !existsSync(paths.project(project)));
}

/** Resumable: returns true when every project is migrated, false when some must be retried on a later start. */
export async function backfillMemory(options: BackfillOptions = {}): Promise<boolean> {
  const db = database();
  try { if (getMeta(db, "backfill_version") === BACKFILL_VERSION) return true; } finally { db.close(); }
  let complete = true;
  for (const project of projectFolders()) {
    await Bun.sleep(0); // yield: the foreground keeps running between projects
    complete = await migrateProject(project, options) && complete;
  }
  const after = database();
  try {
    for (const project of orphanProjects(after)) purgeProject(project);
    if (complete) setMeta(after, "backfill_version", BACKFILL_VERSION);
  } finally { after.close(); }
  return complete;
}

const started = new Map<string, Promise<boolean>>();
/** Fire-and-forget from startup, once per process and archive. Never rejects, never blocks the caller. */
export function startMemoryBackfill(options: BackfillOptions = {}): Promise<boolean> {
  const key = paths.memory;
  let run = started.get(key);
  if (!run) {
    run = backfillMemory(options).catch(error => {
      try { options.log?.(`memory backfill failed; will retry on a later start: ${error instanceof Error ? error.message : error}`); } catch { /* best effort */ }
      return false;
    });
    started.set(key, run);
  }
  return run;
}
