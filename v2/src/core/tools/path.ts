import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { errorCode, fail, ok, paths, type Result } from "../../config";
import type { ToolContext } from "./registry";

const BUILTIN_PLUGINS = resolve(import.meta.dir, "../../plugins");
const inside = (root: string, file: string) => { const r = relative(root, file); return r === "" || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r)); };
const unlessMissing = (error: unknown): null => { if (errorCode(error) === "ENOENT") return null; throw error; };

export async function filePath(input: unknown, ctx: ToolContext, writing = false): Promise<Result<string>> {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) return fail("path must be a non-empty file path");
  const path = resolve(ctx.cwd, input);
  const stat = await lstat(path).catch(unlessMissing);
  if (stat !== null && stat.isSymbolicLink()) return fail("use the resolved file path, not a symlink");
  const canonical = stat !== null ? await realpath(path) : join(await realpath(dirname(path)), path.slice(dirname(path).length + 1));
  const roots = [await realpath(ctx.cwd)];
  if (!writing) for (const dir of [paths.conversation(ctx.conversation), paths.globalData, paths.bubbles, paths.skills, paths.plugins, BUILTIN_PLUGINS]) {
    const resolved = await realpath(dir).catch(unlessMissing);
    if (resolved !== null) roots.push(resolved);
  }
  if (!roots.some(root => inside(root, canonical))) return fail(writing ? "write and edit change files in your working directory only" : "file is outside this agent's workspace, conversation data and skills");
  if (canonical.split("/").includes(".git")) return fail("use Git commands for repository metadata");
  if (stat !== null && !stat.isFile()) return fail("path is not a regular file");
  return ok(canonical);
}
