import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerTask } from "../../../protocol/task/task-ledger";
import { installTaskLedgerSchema } from "./task-ledger";

const open: { db: Database; dir: string }[] = [];
afterEach(() => { for (const { db, dir } of open.splice(0)) { db.close(); rmSync(dir, { recursive: true }); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orca-ledger-"));
  const db = new Database(join(dir, "memory.sqlite"));
  open.push({ db, dir });
  return db;
}
const id = "11111111-1111-4111-8111-111111111111";
function insert(db: Database, number = 1, project = "conversation-a", uuid = id) {
  const task: LedgerTask = { id: uuid, number, title: "Task", summary: "", createdAt: "2026-01-01T00:00:00Z", checkpoints: {}, status: "queued", dependencies: [] };
  db.query("INSERT INTO task_ledger_records VALUES(?,?,?,?,?,?,1,1,NULL)").run(uuid, project, number, uuid, JSON.stringify(task), '{"history":[]}');
}
function install(db: Database) {
  installTaskLedgerSchema(db);
  db.exec("INSERT INTO task_ledger_projects(project_id,repository) VALUES('conversation-a','owner/repo'),('conversation-b','owner/repo')");
}

test("isolated additive install preserves archive versions and survives reopen", () => {
  const db = fixture();
  db.exec("PRAGMA user_version=2; CREATE TABLE tasks(project TEXT,id TEXT,raw TEXT,PRIMARY KEY(project,id)); INSERT INTO tasks VALUES('conversation-a','old','snapshot')");
  install(db); insert(db); installTaskLedgerSchema(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(db.query("SELECT raw FROM tasks").get()).toEqual({ raw: "snapshot" });
  // Same explicit table targeting as archive purge/reindex, without importing app paths.
  db.exec("DELETE FROM tasks WHERE project='conversation-a'; INSERT INTO tasks VALUES('conversation-a','old','replacement')");
  const reader = new Database(join(open[0]!.dir, "memory.sqlite"));
  try { expect(reader.query("SELECT id FROM task_ledger_records").get()).toEqual({ id }); }
  finally { reader.close(); }
});

test("independent version never upgrades archive and rejects future ledger versions", () => {
  const db = fixture();
  db.exec("PRAGMA user_version=1"); installTaskLedgerSchema(db);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  db.exec("UPDATE task_ledger_schema SET version=3");
  expect(() => installTaskLedgerSchema(db)).toThrow("unsupported task ledger");
});

test("conflicting DDL rolls back entirely", () => {
  const db = fixture(); db.exec("CREATE TABLE task_ledger_records(wrong TEXT)");
  expect(() => installTaskLedgerSchema(db)).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('task_ledger_schema','task_ledger_projects')").all()).toEqual([]);
});

test("stable numbers, retained membership and distinct conversation bindings", () => {
  const db = fixture(); install(db); insert(db, 3);
  expect(() => insert(db, 2, "conversation-a", "other")).toThrow("high water");
  insert(db, 1, "conversation-b", "another");
  db.exec("UPDATE task_ledger_records SET revision=2,membership_revision=2,removed_at='2026-02-01' WHERE number=3");
  expect(() => db.exec("DELETE FROM task_ledger_records")).toThrow("retained");
  expect(() => db.exec("UPDATE task_ledger_records SET number=4")).toThrow();
  expect(() => db.exec("UPDATE task_ledger_projects SET high_water=0")).toThrow();
  expect(() => db.exec("UPDATE task_ledger_projects SET repository='other/repo'")).toThrow();
  expect(() => db.exec("DELETE FROM task_ledger_projects")).toThrow();
  expect(db.query("SELECT count(*) AS n FROM task_ledger_records").get()).toEqual({ n: 2 });
});

test("invalid public status/identity and membership revisions fail atomically", () => {
  const db = fixture(); install(db); insert(db);
  for (const patch of ["record_json='{}'", "record_json=json_set(record_json,'$.status','ready_to_merge')", "record_json=json_set(record_json,'$.id','other')", "membership_revision=2"]) {
    expect(() => db.exec(`UPDATE task_ledger_records SET ${patch}`)).toThrow();
  }
  expect(JSON.parse((db.query("SELECT record_json FROM task_ledger_records").get() as { record_json: string }).record_json).checkpoints).toEqual({});
});
