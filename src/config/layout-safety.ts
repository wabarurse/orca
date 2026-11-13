import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const present = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
export function safeDirectory(path: string) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe migration/layout directory: ${path}`);
  return st;
}
export function safeFile(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe layout file: ${path}`);
  return st;
}
/** Enumerate validated project directories without mistaking Finder metadata for a project. */
export function safeProjectDirectories(base: string): string[] {
  const projects = join(base, "projects");
  if (!present(projects)) return [];
  safeDirectory(projects);
  const out: string[] = [];
  for (const name of readdirSync(projects)) {
    const path = join(projects, name);
    // Only a safe regular metadata file is exempt. Never skip arbitrary hidden
    // entries or follow a link that could hide a project from layout checks.
    if (name === ".DS_Store") { safeFile(path); continue; }
    safeDirectory(path);
    out.push(name);
  }
  return out;
}
