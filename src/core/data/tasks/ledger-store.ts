// SQL authority; tasks.json is a compact, version-gated recoverable projection.
// Lock order: dependency lock -> project state lock -> SQLite IMMEDIATE. Never acquire a project lock
// while holding SQLite. Writers (including read repair) must own the project lock;
// existingLedgerTasks is the read-only lock-free snapshot.
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths, repositoryBinding, directoryProject } from "../../../config";
import { projectIdentity, matchesProjectIdentity } from "../projects";
import { openExistingReadonly } from "../sqlite";
import { installTaskLedgerSchema } from "../sqlite";
import { canonicalTask, type LedgerTask } from "../../../protocol/task";
import type { Task } from "../../../protocol/task";

export interface TaskStore { version: 1; tasks: Task[] }
interface Row { record_json: string; safety_json: string; removed_at: string | null }
const file = (project: string) => `${paths.project(project)}/tasks.json`;
function database(): Database {
  mkdirSync(dirname(paths.memory), { recursive: true });
  closeSync(openSync(paths.memory, "a", 0o600));
  const db = new Database(paths.memory, { strict: true });
  try {
    db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL");
    installTaskLedgerSchema(db);
    for (const p of [paths.memory, `${paths.memory}-wal`, `${paths.memory}-shm`]) if (existsSync(p)) chmodSync(p, 0o600);
    return db;
  } catch (error) { db.close(); throw error; }
}
function binding(project: string): string {
  return JSON.stringify({ identity: projectIdentity(project), repository: repositoryBinding(project) ?? paths.repo(project) });
}
/** The SQL binding stays immutable. Compatibility changes representation, never
 * ownership: require the same conversation and exact repository/worktree identity. */
function matchesBinding(project: string, encoded: string): boolean {
  let saved: { identity?: unknown; repository?: unknown };
  try { saved = JSON.parse(encoded); } catch { return false; }
  if (!saved || typeof saved.identity !== "string" || !matchesProjectIdentity(project, saved.identity)) return false;
  const current = repositoryBinding(project) ?? paths.repo(project);
  if (typeof saved.repository === "string" || typeof current === "string") {
    if (saved.repository === current) return true;
    // Only the explicit same-conversation storage move changes an unbound legacy
    // fallback path. Conversation identity was verified above; arbitrary routes
    // and newly bound repositories still fail closed.
    return current === join(paths.root, "projects", ".conversations", project, "repo") &&
      saved.repository === join(paths.root, "projects", project, "repo");
  }
  const old = saved.repository as typeof current | undefined;
  if (!old || old.version !== current.version || old.worktreeId !== current.worktreeId) return false;
  if (old.directory === current.directory && old.branch === current.branch) return true;
  // A validated explicit relink records its former route; a random binding edit
  // or another conversation's repository is never silently adopted.
  return directoryProject(paths.memory, project)?.previousDirectories?.some(route => route.directory === old.directory && route.branch === old.branch) ?? false;
}
function atomic(path: string, bytes: string): void {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
function importLegacy(db: Database, project: string, validate: (raw: unknown) => asserts raw is Task): void {
  const saved = db.query("SELECT repository FROM task_ledger_projects WHERE project_id=?").get(project) as { repository: string } | null;
  if (saved) {
    if (!matchesBinding(project, saved.repository)) throw new Error("task ledger project identity/repository changed; explicit recovery required");
    // A v1 writer must never become authority again after migration.
    if (existsSync(file(project))) {
      let raw: { version?: number };
      try { raw = JSON.parse(readFileSync(file(project), "utf8")); } catch { return; } // repair corrupt projection
      if (raw.version !== 1 && raw.version !== 2) throw new Error("unsupported task projection version; upgrade all processes");
      if (raw.version === 1) {
        const backup = `${file(project)}.legacy-v1.backup`;
        if (!existsSync(backup) || readFileSync(backup, "utf8") !== readFileSync(file(project), "utf8"))
          throw new Error("legacy task writer detected after ledger activation; stop all old processes before recovery");
      }
    }
    return;
  }
  let tasks: Task[] = [];
  if (existsSync(file(project))) {
    const bytes = readFileSync(file(project), "utf8"), raw = JSON.parse(bytes);
    if (raw.version !== 1 || !Array.isArray(raw.tasks)) throw new Error("unsupported task projection without ledger; restore memory.sqlite backup");
    const ids = new Set<string>(), runs = new Set<string>();
    for (const task of raw.tasks) {
      validate(task);
      if (ids.has(task.id.toLowerCase())) throw new Error("duplicate legacy task UUID");
      ids.add(task.id.toLowerCase());
      for (const run of task.runs) { if (runs.has(run.id)) throw new Error("duplicate legacy run"); runs.add(run.id); }
    }
    tasks = raw.tasks.sort((a: Task, b: Task) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const backup = `${file(project)}.legacy-v1.backup`;
    if (existsSync(backup)) {
      if (readFileSync(backup, "utf8") !== bytes) throw new Error("legacy backup differs; explicit recovery required");
    } else writeFileSync(backup, bytes, { mode: 0o600, flag: "wx" });
  }
  db.query("INSERT INTO task_ledger_projects(project_id,repository) VALUES(?,?)").run(project, binding(project));
  for (const task of tasks) save(db, project, task);
}
function load(db: Database, project: string): TaskStore {
  const rows = db.query("SELECT record_json,safety_json,removed_at FROM task_ledger_records WHERE project_id=? ORDER BY number").all(project) as Row[];
  return { version: 1, tasks: rows.map(row => {
    const record: LedgerTask = JSON.parse(row.record_json), { legacy } = JSON.parse(row.safety_json);
    if (!legacy) throw new Error("task ledger safety snapshot missing");
    return { ...legacy, id: record.id, name: record.title, summary: record.summary, createdAt: record.createdAt, dependsOn: record.dependencies, number: record.number, checkpoints: record.checkpoints, ...(row.removed_at ? { removedAt: row.removed_at } : {}) };
  }) };
}
function save(db: Database, project: string, task: Task): void {
  const old = db.query("SELECT revision,membership_revision,removed_at FROM task_ledger_records WHERE id=? AND project_id=?").get(task.id, project) as { revision: number; membership_revision: number; removed_at: string | null } | null;
  if (!old) task.number = (db.query("SELECT high_water FROM task_ledger_projects WHERE project_id=?").get(project) as { high_water: number }).high_water + 1;
  task.dependsOn ??= [];
  const record = canonicalTask(task);
  task.checkpoints = record.checkpoints;
  const removed = task.removedAt ?? null;
  const safety = JSON.stringify({ legacy: task });
  if (old) {
    if (task.revision < old.revision) throw new Error("task revision regressed");
    db.query("UPDATE task_ledger_records SET record_json=?,safety_json=?,revision=?,membership_revision=?,removed_at=? WHERE id=? AND project_id=?")
      .run(JSON.stringify(record), safety, task.revision, removed !== old.removed_at ? task.revision : old.membership_revision, removed, task.id, project);
  } else db.query("INSERT INTO task_ledger_records VALUES(?,?,?,?,?,?,?, ?,NULL)")
    .run(task.id, project, task.number!, task.id, JSON.stringify(record), safety, task.revision, task.revision);
}
function projectView(db: Database, project: string): void {
  const rows = db.query("SELECT record_json FROM task_ledger_records WHERE project_id=? AND removed_at IS NULL ORDER BY number").all(project) as { record_json: string }[];
  const revisions = db.query("SELECT id,revision,membership_revision FROM task_ledger_records WHERE project_id=? ORDER BY number").all(project);
  const bytes = JSON.stringify({ version: 2, revisions, tasks: rows.map(r => JSON.parse(r.record_json)) }) + "\n";
  if (!existsSync(file(project)) || readFileSync(file(project), "utf8") !== bytes) atomic(file(project), bytes);
}
/** Commit precedes projection rename. If rename fails, the next read repairs from
 * SQL (including tombstones); it NEVER imports an older JSON snapshot over SQL. */
export function ledgerTransaction<T>(project: string, validate: (raw: unknown) => asserts raw is Task, action: (store: TaskStore) => T): T {
  const db = database();
  try {
    const result = db.transaction(() => {
      importLegacy(db, project, validate);
      const store = load(db, project);
      const before = new Map(store.tasks.map(t => [t.id, JSON.stringify(t)]));
      const result = action(store);
      for (const t of store.tasks) { validate(t); if (before.get(t.id) !== JSON.stringify(t)) save(db, project, t); }
      return result;
    }).immediate();
    projectView(db, project);
    return result;
  } finally { db.close(); }
}

/** Explicit workspace cleanup only, under the project lock. Keep numbering and
 * binding receipts. The retention guard is restored in the same transaction;
 * concurrent/ordinary writers never observe an unguarded ledger. */
export function purgeLedgerTasks(project: string, ids: string[]): void {
  const db = database();
  try {
    db.transaction(() => {
      const saved = db.query("SELECT repository FROM task_ledger_projects WHERE project_id=?").get(project) as { repository: string } | null;
      if (!saved || !matchesBinding(project, saved.repository)) throw new Error("task cleanup identity changed");
      const store = load(db, project), selected = new Set(ids);
      if (store.tasks.some(t => !selected.has(t.id) && t.dependsOn?.some(id => selected.has(id)))) throw new Error("tasks are still referenced by retained dependencies");
      const guard = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='task_ledger_retain'").get() as { sql: string } | null;
      if (!guard?.sql) throw new Error("task retention guard is unavailable");
      db.exec("DROP TRIGGER task_ledger_retain");
      for (const id of selected) db.query("DELETE FROM task_ledger_records WHERE project_id=? AND id=?").run(project, id);
      db.exec(guard.sql);
      for (const table of ["tasks", "entry_tasks"]) if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        for (const id of selected) db.query(`DELETE FROM ${table} WHERE project=? AND ${table === "tasks" ? "id" : "task_id"}=?`).run(project, id);
      }
    }).immediate();
    projectView(db, project);
  } finally { db.close(); }
}

/** Deleting the project itself, under its lock and while its identity can still be read: every
 * task record and the binding go, so a project created later under the same name starts its own
 * ledger at #1 instead of failing closed on the old one. Both retention guards are restored in
 * the same transaction. A ledger bound to another identity is never touched. */
export function purgeLedgerProject(project: string): void {
  if (!existsSync(paths.memory)) return;
  const db = database();
  try {
    db.transaction(() => {
      if (!db.query("SELECT name FROM sqlite_master WHERE name='task_ledger_projects'").get()) return;
      const saved = db.query("SELECT repository FROM task_ledger_projects WHERE project_id=?").get(project) as { repository: string } | null;
      if (!saved) return;
      if (!matchesBinding(project, saved.repository)) throw new Error("task ledger belongs to another project identity; nothing was deleted");
      const guards = (db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('task_ledger_retain','task_ledger_project_retain')").all() as { sql: string }[]).map(row => row.sql);
      if (guards.length !== 2 || guards.some(sql => !sql)) throw new Error("task retention guard is unavailable");
      db.exec("DROP TRIGGER task_ledger_retain; DROP TRIGGER task_ledger_project_retain");
      db.query("DELETE FROM task_ledger_records WHERE project_id=?").run(project);
      db.query("DELETE FROM task_ledger_projects WHERE project_id=?").run(project);
      for (const sql of guards) db.exec(sql);
    }).immediate();
  } finally { db.close(); }
}

/** Read-only durable lookup: no import, repair, project creation or membership writes. */
export function searchLedger(input: Record<string, unknown>): unknown[] {
  if (!existsSync(paths.memory)) return [];
  const db = openExistingReadonly(paths.memory);
  if (!db) return [];
  try {
    db.exec("PRAGMA busy_timeout=2000");
    if (!db.query("SELECT name FROM sqlite_master WHERE name='task_ledger_records'").get()) return [];
    const query = String(input.query ?? "");
    if (query.length > 256) throw new Error("memory query exceeds 256 characters");
    const limit = input.limit ?? 5;
    if (input.status !== undefined && !["all", "merged", "active"].includes(String(input.status))) throw new Error("invalid memory status");
    for (const key of ["project", "taskId"] as const) if (input[key] !== undefined && typeof input[key] !== "string") throw new Error(`invalid ${key}`);
    const project = input.project as string | undefined, taskId = input.taskId as string | undefined, status = String(input.status ?? "all");
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 10) throw new Error("invalid memory limit");
    return db.query(`SELECT project_id,record_json,removed_at FROM task_ledger_records
      WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR id=?)
      AND instr(lower(record_json),lower(?))>0
      AND (?='all' OR (?='merged')=(json_extract(record_json,'$.status')='merged'))
      ORDER BY project_id,number LIMIT ?`).all(project ?? null, project ?? null, taskId ?? null, taskId ?? null, query, status, status, Number(limit))
      .map(raw => { const row = raw as { project_id: string; record_json: string; removed_at: string | null }; return { project: row.project_id, task: JSON.parse(row.record_json), removedAt: row.removed_at }; });
  } finally { db.close(); }
}

/** Existing SQL snapshot only, for memory queries that must never activate or repair. */
export function existingLedgerTasks(project: string): Task[] | undefined {
  if (!existsSync(paths.memory)) return;
  const db = openExistingReadonly(paths.memory);
  if (!db) return;
  try {
    db.exec("PRAGMA busy_timeout=2000");
    if (!db.query("SELECT name FROM sqlite_master WHERE name='task_ledger_records'").get()) return;
    const saved = db.query("SELECT repository FROM task_ledger_projects WHERE project_id=?").get(project) as { repository: string } | null;
    if (!saved) return;
    if (!matchesBinding(project, saved.repository)) throw new Error("task ledger project identity/repository changed; explicit recovery required");
    return load(db, project).tasks;
  } finally { db.close(); }
}
