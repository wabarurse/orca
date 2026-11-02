// A readable filesystem view over stable conversation artifacts. Only generated
// metadata and validated links are replaced; user-added files are never removed.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { present, safeDirectory, safeFile } from "./layout-safety";
export interface FolderProject { id: string; name: string; directory: string; conversations: { id: string; name: string }[] }
const slug = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 64) || "untitled";
const folderName = (p: FolderProject) => `${slug(p.name)}--${p.id === "unassigned" ? p.id : p.id.slice(0, 8)}`;
const linkName = (c: { id: string; name: string }) => `${slug(c.name)}--${c.id.replace(/^orch-/, "")}`;
function metadata(path: string): { id: string } {
  const file = join(path, "project.json"); safeFile(file);
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || typeof value.id !== "string") throw new Error("invalid project folder metadata");
  return value;
}
function target(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid conversation link id");
  return `../../.conversations/${id}`;
}
function managedLink(file: string): string {
  const st = lstatSync(file);
  if (!st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error(`refusing to replace a user file: ${file}`);
  const value = readlinkSync(file);
  if (!/^\.\.\/\.\.\/\.conversations\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`unsafe conversation link: ${file}`);
  return value;
}
function publishFile(path: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (present(path)) { safeFile(path); if (readFileSync(path, "utf8") === bytes) return; }
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { if (present(temp)) unlinkSync(temp); }
}
function links(path: string, conversations: FolderProject["conversations"]): void {
  safeDirectory(path);
  const expected = new Map(conversations.map(c => [linkName(c), target(c.id)]));
  for (const [name, to] of expected) {
    const file = join(path, name);
    if (present(file)) { if (managedLink(file) === to) continue; throw new Error(`conversation link collision: ${file}`); }
    symlinkSync(to, file);
  }
  for (const name of readdirSync(path)) {
    if (name === ".DS_Store") { safeFile(join(path, name)); continue; }
    const file = join(path, name);
    if (!lstatSync(file).isSymbolicLink()) { safeFile(file); continue; }
    managedLink(file);
    if (!expected.has(name)) unlinkSync(file);
  }
}
/** Caller serializes the view with the project-folders state lock. */
export function syncNamedFolders(root: string, projects: FolderProject[]): void {
  const base = join(root, "projects");
  if (!present(join(base, ".conversations"))) return; // Offline legacy migration has not run.
  safeDirectory(base); safeDirectory(join(base, ".conversations"));
  const names = new Set<string>();
  for (const p of projects) {
    if (!/^(?:[a-f0-9-]{36}|unassigned)$/.test(p.id)) throw new Error("invalid directory project id");
    const name = folderName(p), path = join(base, name);
    if (names.has(name)) throw new Error("directory folder name collision"); names.add(name);
    if (!present(path)) {
      const staging = join(root, ".runtime", "project-folder-staging"); mkdirSync(staging, { recursive: true, mode: 0o700 }); safeDirectory(staging);
      const temp = mkdtempSync(join(staging, "view-"));
      mkdirSync(join(temp, "conversations"), { mode: 0o700 });
      publishFile(join(temp, "project.json"), { version: 1, id: p.id, name: p.name, directory: p.directory });
      links(join(temp, "conversations"), p.conversations);
      renameSync(temp, path);
    } else {
      safeDirectory(path);
      if (metadata(path).id !== p.id) throw new Error(`directory folder collision: ${name}`);
      links(join(path, "conversations"), p.conversations);
      publishFile(join(path, "project.json"), { version: 1, id: p.id, name: p.name, directory: p.directory });
    }
  }
  // Retire obsolete views only after all replacement views have been published.
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (names.has(name) || name === ".conversations" || name === ".DS_Store" || !present(join(path, "project.json"))) continue;
    safeDirectory(path); metadata(path);
    links(join(path, "conversations"), []);
    const entries = readdirSync(path), children = readdirSync(join(path, "conversations"));
    if (children.length || entries.some(n => n !== "project.json" && n !== "conversations")) continue;
    rmdirSync(join(path, "conversations")); unlinkSync(join(path, "project.json")); rmdirSync(path);
  }
}
