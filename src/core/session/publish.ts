// Staging and publication of an import, journaled so a crash or a failure part-way is recoverable.
//
// Everything is first written into sync-staging/<id>/ in the state root (same filesystem as projects/ and
// .runtime/), verified there, and described by sync-staging/<id>/journal.json. Publication is then a sequence of
// steps, each undoable until the commit point:
//   1. every file replaced is first COPIED to sync-backup/<project>/<time>/ (never inside the project, so the TUI
//      never lists it), then the staged file is renamed over it;
//   2. state keys (model, settings, ...) are written, their previous values kept in the journal;
//   3. the journal moves to phase "committing" -- from here the import rolls FORWARD, never back;
//   4. tasks are merged in ONE SQLite ledger transaction (the ledger forbids regression, so it cannot be undone and
//      is applied last; it is atomic and idempotent);
//   5. session.json (the sync ledger) is written last, so a half-published import never claims a sync.
// A failure before the commit point rolls back (files restored by copy + rename, state keys rewritten, a newly
// created project removed). If the rollback itself fails, that is reported with the backup and journal locations and
// the journal is kept. A crash leaves the journal; `recoverImports()` (run at the start of every import and by
// `orca session recover`) rolls back a journal in phase "applying" and completes one in phase "committing".
// "Atomic" here means: each file is replaced by a rename, and the whole import is recoverable; it is not one
// filesystem transaction.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths, readProjectState, writeProjectState } from "../../config";
import { directories, session, withProjectStateLock } from "../data/projects";
import { applySessionTasks } from "../data/tasks";
import type { Task } from "../../protocol/task";
import type { StateChange, Write } from "./plan";

interface Step { index: number; area: Write["area"]; path: string; backedUp: boolean }
interface SavedState { key: string; before: { present: boolean; value?: unknown } }
interface Journal {
  version: 1; id: string; project: string; created: boolean; phase: "applying" | "committing";
  backup: string; steps: Step[]; state: SavedState[]; tasks: Task[] | null; session: session.SessionFile;
}
export interface PublishInput {
  project: string; created: boolean; writes: Write[]; state: StateChange[]; tasks?: Task[]; session: session.SessionFile; now: Date;
  /** Verify the staged files (`stage/files/<n>`); throw to abort before anything is published. */
  verify: (stage: string, order: Write[]) => Promise<void>;
  /** Test seam: called at named points; a thrown `CrashForTest` leaves everything as a killed process would. */
  hook?: (point: string, stage: string) => Promise<void> | void;
}
/** Thrown by a test hook to simulate the process dying: no rollback or cleanup runs. */
export class CrashForTest extends Error {}

const stagingRoot = () => join(paths.root, "sync-staging");
const target = (project: string, w: { area: Write["area"]; path: string }) => join(w.area === "project" ? paths.project(project) : paths.questions(project), w.path);
const safeRel = (path: string) => { if (!path || path.startsWith("/") || path.split("/").some(s => s === ".." || s === "." || s === "")) throw new Error(`unsafe staged path ${path}`); };
const ENOENT = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
const writeJournal = (stage: string, j: Journal) => atomicWrite(join(stage, "journal.json"), JSON.stringify(j));

async function stageFiles(stage: string, writes: Write[]): Promise<void> {
  await mkdir(join(stage, "files"), { recursive: true, mode: 0o700 });
  for (const [i, w] of writes.entries()) { safeRel(w.path); await writeFile(join(stage, "files", String(i)), w.bytes, { flag: "wx", mode: 0o600 }); }
}

async function applyFiles(stage: string, j: Journal): Promise<void> {
  for (const step of j.steps) {
    const to = target(j.project, step);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    if (step.backedUp) {
      const copy = join(j.backup, step.area, step.path);
      await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
      await copyFile(to, copy);
    }
    await rename(join(stage, "files", String(step.index)), to);
  }
}

/** Restore one replaced file by copying its backup next to it and renaming over it; a file that was new is removed. */
async function restore(j: Journal, step: Step): Promise<void> {
  const to = target(j.project, step), copy = join(j.backup, step.area, step.path);
  if (step.backedUp && existsSync(copy)) {
    const temp = `${to}.${randomUUID()}.restore`;
    try { await copyFile(copy, temp); await rename(temp, to); } finally { await rm(temp, { force: true }); }
  } else if (!step.backedUp) await rm(to, { force: true });
}

/** A project this import created: its folder, runtime state and readable folder links go, as /delete removes a conversation. */
async function removeCreated(project: string): Promise<void> {
  await rm(paths.project(project), { recursive: true, force: true });
  await rm(paths.runtimeProject(project), { recursive: true, force: true });
  await directories.refreshFolders();
}

/** Undo a journal in phase "applying". Throws, naming what could not be undone, when anything fails. */
async function rollback(stage: string, j: Journal): Promise<void> {
  const failed: string[] = [];
  for (const step of [...j.steps].reverse()) await restore(j, step).catch(e => failed.push(`${step.path} (${e instanceof Error ? e.message : e})`));
  for (const saved of [...j.state].reverse()) {
    try { writeProjectState(j.project, saved.key, saved.before.present ? saved.before.value : undefined); }
    catch (e) { failed.push(`state ${saved.key} (${e instanceof Error ? e.message : e})`); }
  }
  if (j.created) await removeCreated(j.project).catch(e => failed.push(`new project folder (${e instanceof Error ? e.message : e})`));
  if (failed.length) throw new Error(`rollback incomplete, ${failed.length} item(s) not restored: ${failed.join("; ")}. Backups of replaced files are in ${j.backup}; the journal ${join(stage, "journal.json")} was kept: run \`orca session recover\` to retry`);
  await rm(stage, { recursive: true, force: true });
}

/** Publish `opts.writes` and the rest; see the header for the failure model. Returns the backup directory when files were replaced. */
export async function publish(opts: PublishInput): Promise<{ backup?: string }> {
  const id = randomUUID(), stage = join(stagingRoot(), id);
  const backup = join(paths.root, "sync-backup", opts.project, `${opts.now.toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}`);
  let journal: Journal | undefined, retain = false;
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await stageFiles(stage, opts.writes);
    await opts.hook?.("staged", stage);
    await opts.verify(stage, opts.writes);
    journal = {
      version: 1, id, project: opts.project, created: opts.created, phase: "applying", backup,
      steps: opts.writes.map((w, index) => ({ index, area: w.area, path: w.path, backedUp: existsSync(target(opts.project, w)) })),
      state: opts.state.map(s => { const before = readProjectState<unknown>(opts.project, s.key); return { key: s.key, before: before === undefined ? { present: false } : { present: true, value: before } }; }),
      tasks: opts.tasks ?? null, session: opts.session,
    };
    await writeJournal(stage, journal);
    await applyFiles(stage, journal);
    await opts.hook?.("files", stage);
    for (const s of opts.state) writeProjectState(opts.project, s.key, s.value);
    await opts.hook?.("state", stage);
    journal.phase = "committing";
    await writeJournal(stage, journal);
    await commit(stage, journal, opts.hook);
    return journal.steps.some(s => s.backedUp) ? { backup } : {};
  } catch (error) {
    if (error instanceof CrashForTest) { retain = true; throw error; }
    throw await failed(stage, journal, opts, error, () => { retain = true; });
  } finally { if (!retain) await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

/** Tasks then session.json. A task failure leaves the ledger untouched, so it rolls back; a failure after tasks rolls forward. */
async function commit(stage: string, j: Journal, hook?: PublishInput["hook"]): Promise<void> {
  try { await hook?.("tasks", stage); if (j.tasks) await applySessionTasks(j.project, j.tasks); }
  catch (error) {
    if (error instanceof CrashForTest) throw error;
    j.phase = "applying"; await writeJournal(stage, j);
    throw error;
  }
  try { await hook?.("session", stage); await session.writeSession(j.project, j.session); }
  catch (error) {
    if (error instanceof CrashForTest) throw error;
    throw new SyncRecordFailed(`the import is complete except its sync record (${error instanceof Error ? error.message : error}); run \`orca session recover\` to finish it (journal ${join(stage, "journal.json")})`);
  }
  await rm(stage, { recursive: true, force: true });
}
class SyncRecordFailed extends Error {}

async function failed(stage: string, journal: Journal | undefined, opts: PublishInput, error: unknown, retain: () => void): Promise<unknown> {
  if (error instanceof SyncRecordFailed) { retain(); return error; }
  try {
    if (journal) await rollback(stage, journal);
    else if (opts.created) await removeCreated(opts.project);
  } catch (rollbackError) { retain(); return rollbackError; }
  return error;
}

// ---- recovery ----

async function journals(): Promise<{ stage: string; journal: Journal }[]> {
  const out: { stage: string; journal: Journal }[] = [];
  for (const name of await readdir(stagingRoot()).catch(e => { if (ENOENT(e)) return [] as string[]; throw e; })) {
    const stage = join(stagingRoot(), name);
    const text = await readFile(join(stage, "journal.json"), "utf8").catch(e => { if (ENOENT(e)) return undefined; throw e; });
    if (text !== undefined) out.push({ stage, journal: JSON.parse(text) as Journal });
  }
  return out;
}

/** Interrupted imports of `project` (or of any project), as human-readable lines. */
export async function pendingImports(project?: string): Promise<string[]> {
  return (await journals()).filter(({ journal }) => !project || journal.project === project).map(({ journal }) => `${journal.project} (${journal.phase})`);
}

/** Resolve every journal left by a crashed or failed import: "applying" rolls back, "committing" is completed. Returns what was done. */
export async function recoverImports(): Promise<string[]> {
  const done: string[] = [];
  for (const { stage, journal } of await journals()) {
    await withProjectStateLock(journal.project, async () => {
      if (journal.phase === "applying") { await rollback(stage, journal); done.push(`rolled back the interrupted import into ${journal.project}`); }
      else { await commit(stage, journal); done.push(`completed the interrupted import into ${journal.project}`); }
    });
  }
  return done;
}
