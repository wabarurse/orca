import { repositoryInstructions } from "../data/knowledge";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../../config";
import { withStorageLock } from "../data";
import type { Tool, ToolContext } from "./registry";

const MAX_FILE = 2 * 1024 * 1024;
const revision = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, file: string) => { const r = relative(root, file); return !r || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r)); };

/** Claude Code's separate Read/Write/Edit capabilities inspired this interface;
 * freshness checks and atomic per-file publication are Orca's implementation.
 * https://code.claude.com/docs/en/how-claude-code-works */
async function filePath(input: unknown, ctx: ToolContext, writing = false): Promise<string> {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) throw new Error("path must be a non-empty file path");
  if (writing && ctx.role === "reviewer") throw new Error("reviewers have read-only file access");
  const path = resolve(ctx.cwd, input);
  const stat = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (stat?.isSymbolicLink()) throw new Error("use the resolved file path, not a symlink");
  const canonical = stat ? await realpath(path) : join(await realpath(dirname(path)), path.slice(dirname(path).length + 1));
  const roots = [await realpath(ctx.cwd)];
  if (!writing) for (const dir of [paths.project(ctx.project), paths.runtimeProject(ctx.project), join(paths.root, "skills")]) {
    const resolved = await realpath(dir).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (resolved) roots.push(resolved);
  }
  if (!roots.some(root => inside(root, canonical))) throw new Error("file is outside this agent's workspace and evidence directories");
  if (canonical.split("/").includes(".git")) throw new Error("use Git commands for repository metadata");
  if (stat && !stat.isFile()) throw new Error("path is not a regular file");
  return canonical;
}

async function contents(path: string): Promise<Buffer> {
  const s = await lstat(path);
  if (!s.isFile() || s.size > MAX_FILE) throw new Error("file is not a regular text file under 2 MiB; use a bounded command");
  const data = await readFile(path);
  if (data.length > MAX_FILE || data.includes(0)) throw new Error("binary or oversized file; use an appropriate command");
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error("file is not UTF-8; use an encoding-aware command"); }
  return data;
}

async function mutate(path: string, expected: unknown, transform: (old: string) => string, create: boolean) {
  const lock = join(paths.runtime, "file-locks", revision(path));
  return withStorageLock(lock, async () => {
    const old = await contents(path).catch(error => { if (create && error.code === "ENOENT") return undefined; throw error; });
    if (create && old) throw new Error("file exists; read it and provide expected_revision to replace it");
    if (!create && (typeof expected !== "string" || !old || revision(old) !== expected)) throw new Error("file changed or expected_revision is missing; read the current file before editing");
    const next = transform(old?.toString("utf8") ?? "");
    if (Buffer.byteLength(next) > MAX_FILE) throw new Error("write exceeds 2 MiB");
    const staged = join(dirname(path), `.orca-write-${crypto.randomUUID()}`);
    try {
      await writeFile(staged, next, { flag: "wx", mode: 0o600 });
      if (old) {
        const s = await lstat(path);
        if (!s.isFile() || s.isSymbolicLink() || revision(await readFile(path)) !== expected) throw new Error("file changed during edit; no changes applied");
        await chmod(staged, s.mode & 0o777);
        await rename(staged, path);
      } else await link(staged, path); // Exclusive create: never overwrite a raced file.
    } finally { await unlink(staged).catch(() => {}); }
    return JSON.stringify({ path, revision: revision(next), bytes: Buffer.byteLength(next), previous_revision: old ? revision(old) : null });
  });
}

export const read: Tool = {
  parallel: () => true,
  spec: { name: "read", description: "Read a UTF-8 file in your workspace or saved evidence. Returns numbered lines, a revision for write/edit, and a continuation line. Output is bounded; do not assume the preview is the whole file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 500 } }, required: ["path"] } },
  async run(input, ctx) {
    const path = await filePath(input.path, ctx), data = await contents(path);
    const start = input.start_line ?? 1, count = input.lines ?? 150;
    if (!Number.isInteger(start) || Number(start) < 1 || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 500) throw new Error("invalid line range");
    const lines = data.toString("utf8").split("\n"), selected: string[] = [];
    let bytes = 0, i = Number(start) - 1;
    for (; i < Math.min(lines.length, Number(start) - 1 + Number(count)); i++) {
      const line = `${i + 1}: ${lines[i]}`;
      if (bytes + Buffer.byteLength(line) > 12000) break;
      selected.push(line); bytes += Buffer.byteLength(line) + 1;
    }
    if (!selected.length && i < lines.length) throw new Error("line exceeds read preview budget; inspect it with a bounded command");
    return JSON.stringify({ path, instructions: await repositoryInstructions(ctx.cwd, dirname(path), true), revision: revision(data), total_lines: lines.length, content: selected.join("\n"), next_line: i < lines.length ? i + 1 : null });
  },
};

export const write: Tool = {
  spec: { name: "write", description: "Create a UTF-8 file, or replace it with expected_revision from read. The parent directory must exist. Existing content is never overwritten without a matching revision.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expected_revision: { type: "string" } }, required: ["path", "content"] } },
  async run(input, ctx) {
    if (typeof input.content !== "string") throw new Error("content must be a string");
    const text = input.content;
    return mutate(await filePath(input.path, ctx, true), input.expected_revision, () => text, input.expected_revision === undefined);
  },
};

export const edit: Tool = {
  spec: { name: "edit", description: "Replace one exact, nonempty, unique text match in a UTF-8 file. Supply expected_revision from read. Stale or ambiguous edits fail without changing the file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, expected_revision: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "expected_revision", "old_text", "new_text"] } },
  async run(input, ctx) {
    if (typeof input.old_text !== "string" || !input.old_text || typeof input.new_text !== "string") throw new Error("old_text must be nonempty; new_text must be a string");
    const old = input.old_text, next = input.new_text;
    return mutate(await filePath(input.path, ctx, true), input.expected_revision, text => {
      const first = text.indexOf(old);
      if (first < 0 || text.indexOf(old, first + 1) >= 0) throw new Error("edit must match exactly one location; read and include more context");
      return text.slice(0, first) + next + text.slice(first + old.length);
    }, false);
  },
};
