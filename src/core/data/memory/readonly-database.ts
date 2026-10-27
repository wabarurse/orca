import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

/** Read existing SQLite without initializing schemas. WAL siblings may need to be
 * recreated by a read-write connection's read; no database rows are written. */
export function openExistingReadonly(file: string): Database | undefined {
  if (!existsSync(file)) return;
  const open = () => {
    const db = new Database(file, { readonly: true, strict: true });
    try { db.exec("PRAGMA busy_timeout=2000; PRAGMA user_version"); return db; }
    catch (error) { db.close(); throw error; }
  };
  try { return open(); }
  catch (error) {
    if ((error as { code?: string }).code !== "SQLITE_CANTOPEN" || existsSync(`${file}-wal`)) throw error;
    const primer = new Database(file, { readwrite: true, create: false, strict: true });
    try {
      primer.exec("PRAGMA busy_timeout=2000; PRAGMA user_version");
      for (const path of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
      return open();
    } finally { primer.close(); }
  }
}
