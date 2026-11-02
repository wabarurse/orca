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
  const value = stateValue(db, file, scope, key);
  return value === undefined ? undefined : JSON.parse(value) as T;
}
/** Synchronous transaction prevents lost updates across worker processes. Undefined deletes. */
export function updateState<T>(file: string, scope: string, key: string, update: (old: T | undefined) => T | undefined): T | undefined {
  const db = connect(file, true)!;
  return db.transaction(() => {
    const value = stateValue(db, file, scope, key);
    const next = update(value === undefined ? undefined : JSON.parse(value));
    if (next === undefined) {
      db.query("DELETE FROM orca_state WHERE scope=? AND key=?").run(scope, key);
      if (legacyScopes.has(`${file}\0${scope}`)) db.query("INSERT INTO orca_state VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, masked(key), "true");
    }
    else db.query("INSERT INTO orca_state VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, JSON.stringify(next));
    return next;
  }).immediate();
}

// Compatibility aliases are process-local descriptions derived from the persisted
// conversation UUID. Legacy rows stay readable until a key is explicitly written;
// this also observes older agents' late commits during an update handoff.
const legacyScopes = new Map<string, { prefix: string; fingerprint: string }>();
const masked = (key: string) => `@legacy-cleared:${key}`;
export function recoverStateScope(file: string, prefix: string, fingerprint: string, scope: string): void {
  legacyScopes.set(`${file}\0${scope}`, { prefix, fingerprint });
}
/** Retained pre-UUID namespaces prove which device numbers belonged to this
 * directory incarnation. Never infer authority from image bytes or filenames. */
export function legacyStateScopes(file: string, prefix: string, fingerprint: string): string[] {
  const db = connect(file, false);
  if (!db || !exists(db)) return [];
  const rows = db.query("SELECT DISTINCT scope FROM orca_state WHERE scope GLOB ?").all(`${prefix}*:${fingerprint}`) as { scope: string }[];
  return rows.map(row => row.scope).filter(scope => /^\d+$/.test(scope.slice(prefix.length, -fingerprint.length - 1)));
}
function stateValue(db: Database, file: string, scope: string, key: string): string | undefined {
  const own = db.query("SELECT value FROM orca_state WHERE scope=? AND key=?").get(scope, key) as { value: string } | null;
  if (own) return own.value;
  const alias = legacyScopes.get(`${file}\0${scope}`);
  if (!alias || db.query("SELECT 1 FROM orca_state WHERE scope=? AND key=?").get(scope, masked(key))) return;
  const rows = db.query("SELECT scope,value FROM orca_state WHERE key=? AND scope GLOB ?").all(key, `${alias.prefix}*:${alias.fingerprint}`) as {scope: string; value: string}[];
  let value: string | undefined;
  for (const row of rows) {
    if (!/^\d+$/.test(row.scope.slice(alias.prefix.length, -alias.fingerprint.length - 1))) continue;
    if (value !== undefined && value !== row.value) throw new Error(`conflicting legacy project state: ${key}`);
    value = row.value;
  }
  return value;
}
