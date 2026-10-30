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
  return readdirSync(projects).filter(name => {
    const path = join(projects, name);
    if (name === ".DS_Store") {
      // Only a safe regular metadata file is exempt. Never skip arbitrary hidden
      // entries or follow a link that could hide a project from layout checks.
      safeFile(path);
      return false;
    }
    safeDirectory(path);
    return true;
  });
}
/** Validate from the trusted root down before probing any descendant. */
export function safeAncestors(root: string, relative: string, device: number) {
  let path = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    path = join(path, part);
    if (present(path) && safeDirectory(path).dev !== device) throw new Error(`cross-device ancestor refused: ${path}`);
  }
}
