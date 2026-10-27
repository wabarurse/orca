import { randomUUID } from "node:crypto";
// Offline operator tool. Acknowledgement is NOT exclusion of old processes.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { legacyEntries, movedRoot, movedProject } from "./layout";

interface Journal { version: 2; phase: "moving" | "complete" | "rolled-back"; entries: string[]; backed: string[] }
const present = (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
function durable(path: string, data: unknown) {
  const temp = `${path}.next-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function safeDirectory(path: string) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe migration directory: ${path}`);
  return st;
}
function locks(root: string) {
  // Conservative: even a dead-owner lock is retained and requires operator review.
  for (const base of [root, join(root, ".runtime")]) {
    for (const name of ["checkout-locks", "turn-locks", "project-locks", "daemon-locks"]) {
      const path = join(base, name);
      if (present(path) && (safeDirectory(path), readdirSync(path).length)) throw new Error(`lock owners must be resolved offline; refusing ${path}`);
    }
    if (present(join(base, "tmux.sock"))) throw new Error(`socket still exists; verify shutdown and quarantine it manually: ${join(base, "tmux.sock")}`);
    const projects = join(base, "projects");
    if (present(projects)) scan(projects);
  }
  function scan(path: string) {
    safeDirectory(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.name.endsWith(".lock")) throw new Error(`unresolved storage lock: ${child}`);
      // No traversing user checkouts, symlinks or retained file contents.
      if (entry.isDirectory() && !["repo", "worktrees", ".git", "node_modules"].includes(entry.name)) scan(child);
    }
  }
}
export interface MigrationOptions { root: string; bin: string; apply?: boolean; offline?: boolean; rollback?: boolean; afterMove?: (entry: string) => void }
export function migrateLayout(options: MigrationOptions): string[] {
  if (!isAbsolute(options.root) || !isAbsolute(options.bin)) throw new Error("root and bin must be explicit absolute paths");
  const root = resolve(options.root), runtime = join(root, ".runtime"), journalPath = join(runtime, "migration.json");
  const rootStat = safeDirectory(root);
  if (present(options.bin)) safeDirectory(options.bin);
  if (present(runtime) && safeDirectory(runtime).dev !== rootStat.dev) throw new Error("cross-device runtime refused before moving");
  if (present(join(options.bin, ".orca-install.lock"))) throw new Error("installation/updater lock exists; refusing migration");
  locks(root);
  if (present(join(runtime, "activated"))) throw new Error("new layout has been activated; rollback/migration requires a separate data reconciliation, not this script");
  let journal: Journal | undefined;
  if (present(journalPath)) {
    const st = lstatSync(journalPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error("unsafe migration journal");
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
    if (journal?.version !== 2 || !["moving", "complete", "rolled-back"].includes(journal.phase) || !Array.isArray(journal.entries) || !Array.isArray(journal.backed)) throw new Error("invalid migration journal; inspect manually");
    for (const entry of [...journal.entries, ...journal.backed]) if (typeof entry !== "string" || entry.startsWith("/") || entry.split(/[\\/]/).some(p => !p || p === "." || p === "..")) throw new Error("unsafe journal entry");
    for (const entry of journal.entries) {
      const parts = entry.split("/");
      if (!movedRoot.includes(entry) && !(parts.length === 3 && parts[0] === "projects" && movedProject.includes(parts[2]!))) throw new Error("unsupported journal entry");
    }
    if (journal.phase === "rolled-back") throw new Error("migration rolled back; retain journal/backups and inspect before a new attempt");
  }
  const entries = journal?.entries ?? legacyEntries(root);
  if (entries.includes("tmux.sock")) throw new Error("socket requires manual shutdown");
  for (const entry of entries) {
    const source = join(root, entry), target = join(runtime, entry);
    if (present(source) && present(target)) throw new Error(`mixed layout: both paths exist for ${entry}`);
    const existing = present(source) ? source : target;
    if (!present(existing)) throw new Error(`missing migration entry: ${entry}`);
    if (safeDirectory(existing).dev !== rootStat.dev) throw new Error(`cross-device migration refused before moving: ${entry}; use a separately planned offline copy/verify migration`);
  }
  // Reject mounted children too: rename of a mount point can fail even when its
  // top-level parent shares a device. No copy/delete fallback is attempted.
  function devices(path: string) {
    for (const child of readdirSync(path, { withFileTypes: true })) if (child.isDirectory()) {
      const next = join(path, child.name);
      if (lstatSync(next).dev !== rootStat.dev) throw new Error(`cross-device child refused: ${next}`);
      devices(next);
    }
  }
  for (const entry of entries) devices(present(join(root, entry)) ? join(root, entry) : join(runtime, entry));
  // No destination ancestor may redirect copies/renames through a symlink.
  for (const entry of entries) for (const prefix of [runtime, join(runtime, "migration-backup")]) {
    let ancestor = prefix;
    if (present(ancestor) && safeDirectory(ancestor).dev !== rootStat.dev) throw new Error(`cross-device destination refused: ${ancestor}`);
    for (const part of entry.split("/").slice(0, -1)) {
      ancestor = join(ancestor, part);
      if (present(ancestor) && safeDirectory(ancestor).dev !== rootStat.dev) throw new Error(`cross-device destination refused: ${ancestor}`);
    }
  }
  if (!options.apply) return entries;
  if (!options.offline) throw new Error("apply requires explicit offline operator acknowledgement; it cannot prevent old launches");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  if (!journal) {
    if (present(join(runtime, "layout.json"))) throw new Error("layout already versioned without a migration journal");
    journal = { version: 2, phase: "moving", entries, backed: [] };
    durable(journalPath, journal);
  }
  if (options.rollback) {
    for (const entry of [...entries].reverse()) {
      const source = join(root, entry), target = join(runtime, entry);
      if (present(target)) { mkdirSync(dirname(source), { recursive: true, mode: 0o700 }); renameSync(target, source); }
    }
    // Retain the version marker: journal phase gates startup, no evidence deleted.
    journal.phase = "rolled-back"; durable(journalPath, journal);
    return entries;
  }
  for (const entry of entries) {
    const source = join(root, entry), target = join(runtime, entry), backup = join(runtime, "migration-backup", entry);
    if (!present(source)) continue; // crash after atomic rename; durable journal already lists this entry
    if (!journal.backed.includes(entry)) {
      // Interrupted copies are never promoted or overwritten; operator can retain
      // the partial backup under another name before resuming.
      if (present(backup)) throw new Error(`partial backup requires inspection/quarantine before resume: ${backup}`);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      cpSync(source, backup, { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      journal.backed.push(entry); durable(journalPath, journal);
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(source, target);
    // Persist rename directories before declaring completion.
    for (const dir of [dirname(source), dirname(target)]) { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    options.afterMove?.(entry);
  }
  durable(join(runtime, "layout.json"), { version: 2 });
  journal.phase = "complete"; durable(journalPath, journal);
  return entries;
}
