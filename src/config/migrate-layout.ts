import { randomUUID } from "node:crypto";
// Offline operator tool. Acknowledgement is NOT exclusion of old processes.
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { legacyEntries, movedRoot, movedProject } from "./layout";
import { present, safeDirectory, safeFile, safeAncestors } from "./layout-safety";

interface Journal { version: 2; phase: "moving" | "complete" | "rolling-back" | "rolled-back"; entries: string[]; backed: string[] }
type PersistenceEvent = (stage: "renamed" | "synced", path: string) => void;
export interface MigrationOptions {
  root: string; bin: string; apply?: boolean; offline?: boolean; rollback?: boolean;
  afterMove?: (entry: string) => void;
  /** Fault injection/ordering observer; never substitutes filesystem operations. */
  persistenceEvent?: PersistenceEvent;
}
interface Migration { root: string; runtime: string; journalPath: string; device: number; entries: string[]; journal?: Journal }
function syncPath(path: string) {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncParents(source: string, target: string, event?: PersistenceEvent) {
  for (const dir of [dirname(source), dirname(target)]) { syncPath(dir); event?.("synced", dir); }
}
function persistedRename(source: string, target: string, event?: PersistenceEvent) {
  renameSync(source, target);
  event?.("renamed", target);
  syncParents(source, target, event);
}
function durable(path: string, data: unknown) {
  const temp = `${path}.next-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  syncPath(temp);
  renameSync(temp, path);
  syncPath(dirname(path));
}
function scanLocks(path: string) {
  safeDirectory(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.name.endsWith(".lock")) throw new Error(`unresolved storage lock: ${child}`);
    if (entry.isDirectory() && !["repo", "worktrees", ".git", "node_modules"].includes(entry.name)) scanLocks(child);
  }
}
function projectParents(base: string) {
  const projects = join(base, "projects");
  if (!present(projects)) return;
  safeDirectory(projects);
  for (const id of readdirSync(projects)) safeDirectory(join(projects, id));
}
function locksAt(base: string) {
  for (const name of ["checkout-locks", "turn-locks", "project-locks", "daemon-locks"]) {
    const path = join(base, name);
    if (present(path) && (safeDirectory(path), readdirSync(path).length)) throw new Error(`lock owners must be resolved offline; refusing ${path}`);
  }
  if (present(join(base, "tmux.sock"))) throw new Error(`socket still exists; verify shutdown and quarantine it manually: ${join(base, "tmux.sock")}`);
  if (present(join(base, "projects"))) scanLocks(join(base, "projects"));
}
function validateEntry(entry: unknown): asserts entry is string {
  if (typeof entry !== "string" || entry.startsWith("/") || entry.split(/[\\/]/).some(p => !p || p === "." || p === "..")) throw new Error("unsafe journal entry");
  const parts = entry.split("/");
  if (movedRoot.includes(entry)) return;
  if (parts.length === 3 && parts[0] === "projects" && movedProject.includes(parts[2]!)) return;
  throw new Error("unsupported journal entry");
}
function readJournal(path: string): Journal | undefined {
  if (!present(path)) return;
  safeFile(path);
  const journal = JSON.parse(readFileSync(path, "utf8"));
  if (journal?.version !== 2 || !["moving", "complete", "rolling-back", "rolled-back"].includes(journal.phase) || !Array.isArray(journal.entries) || !Array.isArray(journal.backed)) throw new Error("invalid migration journal; inspect manually");
  for (const entry of [...journal.entries, ...journal.backed]) validateEntry(entry);
  if (journal.phase === "rolled-back") throw new Error("migration rolled back; retain journal/backups and inspect before a new attempt");
  return journal;
}
function devices(path: string, device: number) {
  for (const child of readdirSync(path, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const next = join(path, child.name);
    if (safeDirectory(next).dev !== device) throw new Error(`cross-device child refused: ${next}`);
    devices(next, device);
  }
}
function validateMove(m: Migration, entry: string) {
  // Check BOTH sides before even probing the leaf. Applies equally to rollback.
  for (const base of [m.root, m.runtime, join(m.runtime, "migration-backup")]) safeAncestors(base, entry, m.device);
  const source = join(m.root, entry), target = join(m.runtime, entry);
  if (present(source) && present(target)) throw new Error(`mixed layout: both paths exist for ${entry}`);
  const existing = present(source) ? source : target;
  if (!present(existing)) throw new Error(`missing migration entry: ${entry}`);
  if (safeDirectory(existing).dev !== m.device) throw new Error(`cross-device migration refused before moving: ${entry}; use a separately planned offline copy/verify migration`);
  devices(existing, m.device);
}
function migrationRoots(options: MigrationOptions) {
  if (!isAbsolute(options.root) || !isAbsolute(options.bin)) throw new Error("root and bin must be explicit absolute paths");
  const root = resolve(options.root), runtime = join(root, ".runtime"), journalPath = join(runtime, "migration.json");
  const device = safeDirectory(root).dev;
  if (present(options.bin)) safeDirectory(options.bin);
  if (present(runtime) && safeDirectory(runtime).dev !== device) throw new Error("cross-device runtime refused before moving");
  if (present(join(options.bin, ".orca-install.lock"))) throw new Error("installation/updater lock exists; refusing migration");
  return { root, runtime, journalPath, device };
}
function inspect(options: MigrationOptions): Migration {
  const { root, runtime, journalPath, device } = migrationRoots(options);
  // Reject linked project parents BEFORE recursive lock scanning or discovery.
  for (const base of [root, runtime]) projectParents(base);
  for (const base of [root, runtime]) locksAt(base);
  if (present(join(runtime, "activated"))) throw new Error("new layout has been activated; rollback/migration requires a separate data reconciliation, not this script");
  const journal = readJournal(journalPath);
  const entries = journal?.entries ?? legacyEntries(root);
  const m = { root, runtime, journalPath, device, entries, journal };
  for (const entry of entries) validateMove(m, entry);
  return m;
}
function begin(m: Migration): Journal {
  mkdirSync(m.runtime, { recursive: true, mode: 0o700 });
  if (m.journal) return m.journal;
  if (present(join(m.runtime, "layout.json"))) throw new Error("layout already versioned without a migration journal");
  const journal: Journal = { version: 2, phase: "moving", entries: m.entries, backed: [] };
  durable(m.journalPath, journal);
  return journal;
}
function backup(m: Migration, journal: Journal, entry: string) {
  if (journal.backed.includes(entry)) return;
  const source = join(m.root, entry), target = join(m.runtime, "migration-backup", entry);
  if (present(target)) throw new Error(`partial backup requires inspection/quarantine before resume: ${target}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  journal.backed.push(entry); durable(m.journalPath, journal);
}
function moveForward(m: Migration, journal: Journal, options: MigrationOptions) {
  for (const entry of m.entries) {
    const source = join(m.root, entry), target = join(m.runtime, entry);
    if (!present(source)) { syncParents(source, target, options.persistenceEvent); continue; }
    backup(m, journal, entry);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    persistedRename(source, target, options.persistenceEvent);
    options.afterMove?.(entry);
  }
  durable(join(m.runtime, "layout.json"), { version: 2 });
  journal.phase = "complete"; durable(m.journalPath, journal);
}
function rollback(m: Migration, journal: Journal, options: MigrationOptions) {
  journal.phase = "rolling-back"; durable(m.journalPath, journal);
  for (const entry of [...m.entries].reverse()) {
    const source = join(m.runtime, entry), target = join(m.root, entry);
    if (!present(source)) {
      // A prior attempt may have crashed between rename and directory fsync.
      if (present(dirname(source))) syncParents(source, target, options.persistenceEvent);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    persistedRename(source, target, options.persistenceEvent);
  }
  journal.phase = "rolled-back"; durable(m.journalPath, journal);
}
export function migrateLayout(options: MigrationOptions): string[] {
  const m = inspect(options);
  if (!options.apply) return m.entries;
  if (!options.offline) throw new Error("apply requires explicit offline operator acknowledgement; it cannot prevent old launches");
  if (m.journal?.phase === "rolling-back" && !options.rollback) throw new Error("interrupted rollback requires explicit rollback resume");
  const journal = begin(m);
  if (options.rollback) rollback(m, journal, options);
  else moveForward(m, journal, options);
  return m.entries;
}
