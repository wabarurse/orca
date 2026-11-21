import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { parseJson } from "./result";

const Row = z.object({ value: z.string() }).nullable();

const connections = new Map<string, Database>();
process.on("exit", () => { for (const db of connections.values()) db.close(); connections.clear(); });

function connect(file: string): Database {
  const cached = connections.get(file);
  if (cached !== undefined) return cached;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  db.exec("CREATE TABLE IF NOT EXISTS state (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key))");
  connections.set(file, db);
  return db;
}

export function readState<T>(file: string, schema: z.ZodType<T>, scope: string, key: string): T | undefined {
  const row = Row.parse(connect(file).query("SELECT value FROM state WHERE scope=? AND key=?").get(scope, key));
  if (row === null) return undefined;
  const value = parseJson(row.value);
  if (!value.ok) return undefined;
  const parsed = schema.safeParse(value.data);
  return parsed.success ? parsed.data : undefined;
}

export function updateState<T>(file: string, schema: z.ZodType<T>, scope: string, key: string, update: (old: T | undefined) => T | undefined): T | undefined {
  const db = connect(file);
  return db.transaction(() => {
    const next = update(readState(file, schema, scope, key));
    if (next === undefined) db.query("DELETE FROM state WHERE scope=? AND key=?").run(scope, key);
    else db.query("INSERT INTO state VALUES (?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, JSON.stringify(next));
    return next;
  }).immediate();
}
