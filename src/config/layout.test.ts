import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLayout } from "./layout";
import { migrateLayout } from "./migrate-layout";
import { installedApp } from "./legacy";
import { paths } from "./config";
const suite = mkdtempSync(join(tmpdir(), "orca-layout-"));
let root: string, bin: string;
beforeEach(() => { root = mkdtempSync(join(suite, "home-")); bin = join(root, "bin"); mkdirSync(bin); });
afterAll(() => rmSync(suite, { recursive: true, force: true }));
function legacy() {
  for (const p of ["app", "projects/p/runs", "projects/p/inbox", "projects/p/questions", "projects/p/orchestrator", "auth", "turn-locks"]) mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  for (const p of ["config.toml", "memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", "auth/test", "projects/p/tasks.json", "projects/p/repository.json", "projects/p/runs/worker.json", "app/package.json"]) writeFileSync(join(root, p), `retained ${p}`, { mode: 0o600 });
}
const apply = (extra = {}) => migrateLayout({ root, bin, apply: true, offline: true, ...extra });
test("dry-run does not write; existing and mixed layouts fail closed without touching data", () => {
  legacy(); const before = readdirSync(root);
  expect(migrateLayout({ root, bin })).toContain("app");
  expect(readdirSync(root)).toEqual(before);
  expect(() => assertLayout(root)).toThrow("manual offline");
  expect(existsSync(join(root, ".runtime"))).toBe(false);
  expect(() => migrateLayout({ root, bin, apply: true })).toThrow("acknowledgement");
});
test("offline migration keeps ledger/WAL/SHM/auth/config/task evidence and permissions, moves runtime, retains backups", () => {
  legacy(); apply();
  for (const p of ["config.toml", "memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", "auth/test", "projects/p/tasks.json", "projects/p/repository.json"]) {
    expect(readFileSync(join(root, p), "utf8")).toBe(`retained ${p}`);
    expect(lstatSync(join(root, p)).mode & 0o777).toBe(0o600);
  }
  expect(readFileSync(join(root, ".runtime/projects/p/runs/worker.json"), "utf8")).toBe("retained projects/p/runs/worker.json");
  expect(readFileSync(join(root, ".runtime/migration-backup/app/package.json"), "utf8")).toBe("retained app/package.json");
  expect(existsSync(join(root, "app"))).toBe(false);
  apply(); // idempotent before activation
  assertLayout(root);
  expect(() => apply({ rollback: true })).toThrow("activated");
});
test("interrupted moves refuse startup, resume safely and support pre-activation rollback", () => {
  legacy();
  expect(() => apply({ afterMove: () => { throw new Error("injected move interruption"); } })).toThrow("injected");
  expect(() => assertLayout(root)).toThrow("manual offline");
  apply(); apply({ rollback: true });
  expect(readFileSync(join(root, "app/package.json"), "utf8")).toBe("retained app/package.json");
  expect(readFileSync(join(root, "projects/p/runs/worker.json"), "utf8")).toContain("retained");
  expect(() => assertLayout(root)).toThrow("manual offline");
});
test("live, unknown, ownerless, transcript and installer locks all refuse without deleting evidence", () => {
  legacy();
  for (const owner of [undefined, "invalid", JSON.stringify({ pid: process.pid, since: new Date().toISOString() })]) {
    const lock = join(root, "turn-locks/p"); mkdirSync(lock);
    if (owner) writeFileSync(join(lock, "owner.json"), owner);
    expect(() => apply()).toThrow("lock owners"); expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true }); // isolated fixture only
  }
  mkdirSync(join(root, "projects/p/transcripts/x.jsonl.lock"), { recursive: true });
  expect(() => apply()).toThrow("unresolved storage lock");
  rmSync(join(root, "projects/p/transcripts"), { recursive: true });
  mkdirSync(join(bin, ".orca-install.lock")); expect(() => apply()).toThrow("installation/updater");
});
test("mixed paths and insecure roots refuse; new homes version on startup", () => {
  legacy(); mkdirSync(join(root, ".runtime/app"), { recursive: true }); expect(() => apply()).toThrow("mixed layout");
  chmodSync(root, 0o777); expect(() => apply()).toThrow("unsafe migration"); chmodSync(root, 0o700);
  const fresh = join(suite, "fresh"); assertLayout(fresh);
  expect(JSON.parse(readFileSync(join(fresh, ".runtime/layout.json"), "utf8")).version).toBe(2);
});
test("installed path is runtime app; old installation requires explicit migration", () => {
  expect(installedApp(root)).toBe(join(root, ".orca/.runtime/app"));
  mkdirSync(join(root, ".orca/app"), { recursive: true });
  expect(() => installedApp(root)).toThrow("offline layout migration");
});
test("partial backups require inspection; no source or backup evidence removed", () => {
  legacy();
  mkdirSync(join(root, ".runtime/migration-backup/app"), { recursive: true });
  writeFileSync(join(root, ".runtime/migration-backup/app/partial"), "partial evidence");
  expect(() => apply()).toThrow("partial backup");
  expect(readFileSync(join(root, ".runtime/migration-backup/app/partial"), "utf8")).toBe("partial evidence");
  expect(existsSync(join(root, "app/package.json"))).toBe(true);
  expect(() => assertLayout(root)).toThrow("manual offline");
});

test("runtime path helpers keep durable project evidence at stable locations", () => {
  const before = process.env.ORCA_HOME;
  process.env.ORCA_HOME = root;
  try {
    expect(paths.runtime).toBe(join(root, ".runtime"));
    expect(paths.tmuxSocket).toBe(join(root, ".runtime/tmux.sock"));
    expect(paths.daemonLock("p")).toBe(join(root, ".runtime/daemon-locks/p"));
    for (const name of ["inbox", "runs", "questions", "orchestrator"] as const) expect(paths[name]("p")).toBe(join(root, ".runtime/projects/p", name));
    expect(paths.project("p")).toBe(join(root, "projects/p"));
    expect(paths.memory).toBe(join(root, "memory.sqlite"));
  } finally { if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before; }
});
test("manual migration CLI defaults to plan and uses explicit isolated paths", async () => {
  legacy();
  const proc = Bun.spawn([process.execPath, new URL("../../scripts/migrate-layout.ts", import.meta.url).pathname, "--root", root, "--bin", bin], { env: { ...process.env, ORCA_HOME: root, HOME: root }, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code).toBe(0); expect(errors).toBe(""); expect(output).toContain("PLAN ONLY (no writes)");
  expect(existsSync(join(root, ".runtime"))).toBe(false);
});
test("offline migration leaves a real closed SQLite ledger byte-identical with stable project identity", async () => {
  const { Database } = await import("bun:sqlite");
  const { createHash } = await import("node:crypto");
  mkdirSync(join(root, "projects/p/runs"), { recursive: true });
  const db = new Database(join(root, "memory.sqlite"));
  db.run("CREATE TABLE task_ledger (id TEXT PRIMARY KEY, status TEXT, removed_at TEXT)");
  db.run("INSERT INTO task_ledger VALUES ('immutable-id', 'merged', 'retained-removal-evidence')");
  db.close();
  const digest = () => createHash("sha256").update(readFileSync(join(root, "memory.sqlite"))).digest("hex");
  const before = digest(), identity = lstatSync(join(root, "projects/p"));
  apply();
  expect(digest()).toBe(before);
  const after = lstatSync(join(root, "projects/p"));
  expect([after.dev, after.ino, after.birthtimeMs]).toEqual([identity.dev, identity.ino, identity.birthtimeMs]);
  const check = new Database(join(root, "memory.sqlite"), { readonly: true });
  try { expect(check.query("SELECT * FROM task_ledger").all()).toEqual([{ id: "immutable-id", status: "merged", removed_at: "retained-removal-evidence" }]); } finally { check.close(); }
});
