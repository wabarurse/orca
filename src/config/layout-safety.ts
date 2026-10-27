import { lstatSync } from "node:fs";
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
/** Validate from the trusted root down before probing any descendant. */
export function safeAncestors(root: string, relative: string, device: number) {
  let path = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    path = join(path, part);
    if (present(path) && safeDirectory(path).dev !== device) throw new Error(`cross-device ancestor refused: ${path}`);
  }
}
