import type { Database } from "bun:sqlite";

/** Caller-owned connection only; runtime activation belongs to ledger-store.
 * Archive user_version belongs to the rebuildable index (currently 2). Independent
 * ledger versioning lets those readers coexist without downgrading/rejecting it.
 */
export function installTaskLedgerSchema(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS task_ledger_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
    ) STRICT`);
    const row = db.query("SELECT version FROM task_ledger_schema WHERE singleton=1").get() as { version: number } | null;
    if (row && ![1, 2].includes(row.version)) throw new Error("unsupported task ledger schema version");
    if (row?.version === 2) return;
    if (row?.version === 1) { upgradeRetention(db); return; }
    // No IF NOT EXISTS: an unversioned partial/conflicting schema must fail closed.
    db.exec(`
      CREATE TABLE task_ledger_projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        repository TEXT NOT NULL,
        high_water INTEGER NOT NULL DEFAULT 0 CHECK(high_water>=0)
      ) STRICT;
      CREATE TABLE task_ledger_records (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES task_ledger_projects(project_id),
        number INTEGER NOT NULL CHECK(number>0),
        legacy_id TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        safety_json TEXT NOT NULL CHECK(json_valid(safety_json)),
        revision INTEGER NOT NULL CHECK(revision>0),
        membership_revision INTEGER NOT NULL CHECK(membership_revision>0 AND membership_revision<=revision),
        removed_at TEXT,
        UNIQUE(project_id,number), UNIQUE(project_id,legacy_id),
        CHECK(json_type(record_json,'$.id') IS 'text' AND json_extract(record_json,'$.id')=id),
        CHECK(json_type(record_json,'$.number') IS 'integer' AND json_extract(record_json,'$.number')=number),
        CHECK(json_type(record_json,'$.status') IS 'text' AND json_extract(record_json,'$.status') IN ('queued','building','pr open','merged'))
      ) STRICT;
      CREATE TRIGGER task_ledger_allocate BEFORE INSERT ON task_ledger_records BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM task_ledger_projects
          WHERE project_id=NEW.project_id AND high_water<NEW.number)
          THEN RAISE(ABORT,'task number must exceed project high water') END;
        UPDATE task_ledger_projects SET high_water=NEW.number WHERE project_id=NEW.project_id;
      END;
      CREATE TRIGGER task_ledger_identity BEFORE UPDATE OF id,project_id,number,legacy_id ON task_ledger_records
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.number IS NOT OLD.number OR NEW.legacy_id IS NOT OLD.legacy_id
      BEGIN SELECT RAISE(ABORT,'task identity is immutable'); END;
      CREATE TRIGGER task_ledger_retain BEFORE DELETE ON task_ledger_records
      BEGIN SELECT RAISE(ABORT,'task ledger records must be retained'); END;
      CREATE TRIGGER task_ledger_project_retain BEFORE DELETE ON task_ledger_projects
      BEGIN SELECT RAISE(ABORT,'task ledger project binding must be retained'); END;
      CREATE TRIGGER task_ledger_project_identity BEFORE UPDATE ON task_ledger_projects
      WHEN NEW.project_id IS NOT OLD.project_id OR NEW.repository IS NOT OLD.repository OR NEW.high_water<OLD.high_water
      BEGIN SELECT RAISE(ABORT,'task ledger binding/high water cannot regress'); END;
      INSERT INTO task_ledger_schema VALUES(1,1);
    `);
    upgradeRetention(db);
  }).immediate();
}

/** Version 1 was additive/dormant; version 2 is the activation safety upgrade. */
function upgradeRetention(db: Database): void {
  db.exec(`
    CREATE UNIQUE INDEX task_ledger_uuid ON task_ledger_records(lower(id));
    CREATE TRIGGER task_ledger_revision BEFORE UPDATE ON task_ledger_records
    WHEN NEW.revision<OLD.revision OR NEW.membership_revision<OLD.membership_revision
      OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
    BEGIN SELECT RAISE(ABORT,'task revision/membership cannot regress'); END;
    UPDATE task_ledger_schema SET version=2 WHERE singleton=1;
  `);
}
