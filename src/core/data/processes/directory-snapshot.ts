import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

// Disposable directory snapshots omit rebuildable output, never follow file links,
// and have a bounded copy budget. The original folder is never initialized as Git.
const omitted = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache", ".next", ".orca-tmp"]);
export async function copyDirectorySnapshot(source: string, target: string, signal?: AbortSignal): Promise<void> {
  const route = relative(source, target);
  if (!route || (!isAbsolute(route) && route !== ".." && !route.startsWith("../"))) throw new Error("snapshot target must be outside its source directory");
  let bytes = 0, entries = 0;
  const copy = async (from: string, to: string) => {
    signal?.throwIfAborted();
    const info = await lstat(from);
    if (++entries > 20_000) throw new Error("directory snapshot exceeds 20,000 entries");
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`directory snapshot cannot copy links or special files: ${from}`);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const name of await readdir(from)) if (!omitted.has(name)) await copy(join(from, name), join(to, name));
    } else {
      bytes += info.size;
      if (bytes > 256 * 1024 * 1024) throw new Error("directory snapshot exceeds 256 MiB; use a smaller source directory");
      await cp(from, to, { dereference: false, force: false, errorOnExist: true });
    }
  };
  await copy(source, target);
}
