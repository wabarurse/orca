import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
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
    if (name === ".DS_Store") {
      // Only a safe regular metadata file is exempt. Never skip arbitrary hidden
      // entries or follow a link that could hide a project from layout checks.
      safeFile(path);
      continue;
    }
    safeDirectory(path);
    if (name === ".conversations") {
      for (const id of readdirSync(path)) {
        if (id === ".DS_Store") { safeFile(join(path, id)); continue; }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("invalid stored conversation id");
        safeDirectory(join(path, id)); out.push(join(name, id));
      }
    } else if (present(join(path, "project.json"))) {
      safeFile(join(path, "project.json"));
      const marker = JSON.parse(readFileSync(join(path, "project.json"), "utf8"));
      if (marker.version !== 1 || typeof marker.id !== "string" || !/^(?:[a-f0-9-]{36}|unassigned)$/.test(marker.id)) throw new Error("invalid project folder metadata");
      const links = join(path, "conversations"); safeDirectory(links);
      for (const link of readdirSync(links)) {
        if (link === ".DS_Store") { safeFile(join(links, link)); continue; }
        const file = join(links, link), st = lstatSync(file);
        if (!st.isSymbolicLink()) { safeFile(file); continue; }
        if (!st.isSymbolicLink() || st.uid !== process.getuid?.() || !/^\.\.\/\.\.\/\.conversations\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(readlinkSync(file))) throw new Error(`unsafe conversation link: ${file}`);
      }
    } else out.push(name);
  }
  const ids = out.map(p => p.split("/").at(-1));
  if (new Set(ids).size !== ids.length) throw new Error("duplicate conversation storage");
  return out;
}
/** Validate from the trusted root down before probing any descendant. */
export function safeAncestors(root: string, relative: string, device: number) {
  let path = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    path = join(path, part);
    if (present(path) && safeDirectory(path).dev !== device) throw new Error(`cross-device ancestor refused: ${path}`);
  }
}
