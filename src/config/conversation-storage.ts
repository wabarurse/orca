// Stable artifact directories are separate from the human-facing directory tree.
// Renaming a readable link never moves files underneath an open agent/transcript.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { present, safeDirectory, safeFile, safeProjectDirectories } from "./layout-safety";

export function conversationPath(root: string, id: string): string {
  assertStorageAvailable(root);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid conversation id");
  const flat = join(root, "projects", id), store = join(root, "projects", ".conversations"), nested = join(store, id);
  if (present(nested)) {
    safeDirectory(store);
    if (present(flat)) throw new Error(`duplicate conversation storage: ${id}`);
    return nested;
  }
  if (present(flat)) return flat;
  if (present(store)) { safeDirectory(store); return nested; }
  return flat;
}
export function conversationIds(root: string, offline = false): string[] {
  assertStorageAvailable(root);
  const base = join(root, "projects"), store = join(base, ".conversations");
  if (offline || !present(store)) return safeProjectDirectories(root).map(path => path.split("/").at(-1)!).sort();
  safeDirectory(base); safeDirectory(store);
  // Runtime discovery never walks the readable links: they may be renamed in
  // another process and are not identity or execution authority.
  const ids = readdirSync(store).filter(id => {
    if (id === ".DS_Store") { safeFile(join(store, id)); return false; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid stored conversation id");
    safeDirectory(join(store, id));
    if (present(join(base, id))) throw new Error("duplicate conversation storage");
    return true;
  });
  // Retain initialized flat conversations in a partially organized home.
  for (const id of readdirSync(base)) {
    if (id.startsWith(".") || !present(join(base, id, ".identity.json"))) continue;
    safeDirectory(join(base, id)); ids.push(id);
  }
  return ids.sort();
}
export function assertStorageAvailable(root: string): void {
  const lock = join(root, ".runtime", "storage-organization");
  if (!present(lock)) return;
  safeDirectory(lock);
  const file = join(lock, "owner.json");
  let owner: { pid?: number };
  try { owner = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("project storage organization is in progress; retry or rerun orca organize after stopping Orca"); }
  if (owner.pid !== process.pid) throw new Error("project storage organization is in progress; rerun orca organize after stopping Orca if interrupted");
}
/** Fresh homes opt in immediately; existing flat homes require the offline command. */
export function initializeConversationStorage(root: string): void {
  if (conversationIds(root).length) return;
  mkdirSync(join(root, "projects", ".conversations"), { recursive: true, mode: 0o700 });
}
/** Caller excludes old participants and new launches. Each rename is atomic and
 * preserves the inode, UUID and legacy fingerprint. Partial moves are resumable. */
export function organizeConversationStorage(root: string): number {
  const ids = conversationIds(root, true), store = join(root, "projects", ".conversations");
  mkdirSync(store, { recursive: true, mode: 0o700 }); safeDirectory(store);
  const device = safeDirectory(store).dev;
  for (const id of ids) if (safeDirectory(conversationPath(root, id)).dev !== device) throw new Error("cross-device conversation storage move refused");
  let moved = 0;
  for (const id of ids) {
    const source = conversationPath(root, id), target = join(store, id);
    if (source === target) continue;
    safeDirectory(source);
    renameSync(source, target); moved++;
    for (const directory of [join(root, "projects"), store]) {
      const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  return moved;
}
