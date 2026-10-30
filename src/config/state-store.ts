// Durable application records share memory.sqlite with the archive and task ledger.
// This table owns no PRAGMA user_version: archive migrations manage their own schema.
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

function secure(file: string): void {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.()) throw new Error(`unsafe state database: ${file}`);
  if ((s.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
}
const connections = new Map<string, { db: Database; identity: string; initialized: boolean }>();
process.on("exit", () => { for (const c of connections.values()) c.db.close(); connections.clear(); });
function connect(file: string, create: boolean): Database | undefined {
  if (!existsSync(file)) {
    if (!create) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(file, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  secure(file);
  const st = lstatSync(file, { bigint: true }), identity = `${st.dev}:${st.ino}:${st.birthtimeNs}`;
  let cached = connections.get(file);
  if (cached && cached.identity !== identity) { cached.db.close(); connections.delete(file); cached = undefined; }
  const db = cached?.db ?? new Database(file, { readwrite: true, create: false, strict: true });
  try {
    if (!cached) db.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL");
    if (create && !cached?.initialized) {
      const deadline = Date.now() + 10000;
      for (;;) {
        try { db.exec("PRAGMA journal_mode=WAL"); break; }
        catch (error) { if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error; Bun.sleepSync(10); }
      }
      db.exec("CREATE TABLE IF NOT EXISTS orca_state (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key))");
    }
    for (const path of [`${file}-wal`, `${file}-shm`]) if (existsSync(path)) secure(path);
    connections.set(file, { db, identity, initialized: create || cached?.initialized === true });
    if (connections.size > 16) { const first = connections.keys().next().value!; connections.get(first)!.db.close(); connections.delete(first); }
    return db;
  } catch (error) { connections.delete(file); db.close(); throw error; }
}
function exists(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orca_state'").get();
}
export function readState<T>(file: string, scope: string, key: string): T | undefined {
  const db = connect(file, false);
  if (!db) return;
  // Reuse the connection, never a row cache or a transaction spanning calls.
  if (!exists(db)) return;
  const row = db.query("SELECT value FROM orca_state WHERE scope=? AND key=?").get(scope, key) as { value: string } | null;
  return row ? JSON.parse(row.value) as T : undefined;
}
/** Synchronous transaction prevents lost updates across worker processes. Undefined deletes. */
export function updateState<T>(file: string, scope: string, key: string, update: (old: T | undefined) => T | undefined): T | undefined {
  const db = connect(file, true)!;
  return db.transaction(() => {
    const row = db.query("SELECT value FROM orca_state WHERE scope=? AND key=?").get(scope, key) as { value: string } | null;
    const next = update(row ? JSON.parse(row.value) : undefined);
    if (next === undefined) db.query("DELETE FROM orca_state WHERE scope=? AND key=?").run(scope, key);
    else db.query("INSERT INTO orca_state VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, JSON.stringify(next));
    return next;
  }).immediate();
}
