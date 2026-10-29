import { repositoryInstructions } from "../data/knowledge";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../../config";
import { MAX_IMAGE_BYTES, sniffImage, validateImage, type ImageMime } from "../../providers";
import { withStorageLock } from "../data";
import { imageBlock, saveImage } from "../data/images";
import type { Tool, ToolContext, ToolResult } from "./registry";

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

/** The first bytes, enough to recognise a file's format. */
async function head(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(16); const { bytesRead } = await file.read(bytes, 0, 16, 0); return bytes.subarray(0, bytesRead); }
  finally { await file.close(); }
}
const q = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
/** Binary formats an agent meets, by magic bytes, with a command that inspects each.
 * They only name a file already found binary (NUL bytes or not UTF-8), never decide it. */
const BINARIES: { name: string; test: (b: Buffer) => boolean; hint: (path: string) => string }[] = [
  { name: "pdf", test: b => b.toString("latin1", 0, 5) === "%PDF-", hint: p => `pdftotext ${q(p)} - | head -200` },
  { name: "zip archive", test: b => b.toString("latin1", 0, 4) === "PK\x03\x04", hint: p => `unzip -l ${q(p)}` },
  { name: "gzip archive", test: b => b[0] === 0x1f && b[1] === 0x8b, hint: p => `gzip -dc ${q(p)} | head -200` },
  { name: "sqlite database", test: b => b.toString("latin1", 0, 15) === "SQLite format 3", hint: p => `sqlite3 -readonly ${q(p)} .schema` },
  { name: "tiff/bmp/heic image", test: b => ["II*\0", "MM\0*"].includes(b.toString("latin1", 0, 4)) || b.toString("latin1", 0, 2) === "BM" || /^ftyp(heic|heix|mif1)/.test(b.toString("latin1", 4, 12)),
    hint: p => `sips -s format png ${q(p)} --out /tmp/converted.png (macOS), then read the png` },
  { name: "executable", test: b => b.toString("latin1", 0, 4) === "\x7fELF" || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(b.length >= 4 ? b.readUInt32BE(0) : 0), hint: p => `file ${q(p)}; strings ${q(p)} | head -100` },
];
function binary(path: string, start: Buffer): Error {
  const image = sniffImage(start), known = BINARIES.find(b => b.test(start));
  if (image) return new Error(`binary file (${image.slice(6)} image); read returns it as an image, but it cannot be changed as text`);
  return new Error(known ? `binary file (${known.name}); use a command such as \`${known.hint(path)}\``
    : `binary file (unknown type); inspect it with a bounded command such as \`file ${q(path)}; xxd ${q(path)} | head -40\``);
}
async function contents(path: string): Promise<Buffer> {
  const s = await lstat(path);
  if (!s.isFile()) throw new Error("path is not a regular file");
  if (s.size > MAX_FILE) throw new Error(`file is ${mib(s.size)}, over the 2 MiB read limit; read a range with a bounded command such as \`sed -n '1,200p' ${q(path)}\``);
  const data = await readFile(path);
  if (data.length > MAX_FILE) throw new Error("file grew past the 2 MiB read limit; read a range with a bounded command");
  const start = data.subarray(0, 16);
  // Plain UTF-8 text is text whatever its first bytes resemble (a note starting "GIF89a").
  if (data.includes(0)) throw binary(path, start);
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch {
    if (sniffImage(start) || BINARIES.some(b => b.test(start))) throw binary(path, start);
    throw new Error(`file is not UTF-8; use an encoding-aware command such as \`iconv -f latin1 -t utf-8 ${q(path)} | head -200\``);
  }
  return data;
}
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const isText = (data: Buffer) => { if (data.includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; } };
/** Whether a file whose first bytes look like an image is one: an image extension
 * decides; otherwise plain UTF-8 text (a file that merely starts with "GIF89a") is not. */
async function isImage(path: string): Promise<boolean> {
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const s = await lstat(path);
  return s.size > MAX_FILE || !isText(await readFile(path));
}
/** An image file returned as an image: stored in the project image store (as clipboard
 * images are) and delivered as an image block inside the tool_result. */
async function readImage(path: string, mime: ImageMime, ctx: ToolContext): Promise<ToolResult> {
  const format = mime.slice(6), small = path.slice(0, path.length - extname(path).length) + `-small${extname(path) || ".png"}`;
  const downscale = `downscale a copy and read that, e.g. \`sips -Z 1568 ${q(path)} --out ${q(small)}\` (macOS) or \`magick ${q(path)} -resize 1568x1568 ${q(small)}\``;
  const s = await lstat(path);
  if (s.size > MAX_IMAGE_BYTES) throw new Error(`${format} image is ${mib(s.size)}, over the 4 MiB image limit; ${downscale}`);
  const data = await readFile(path);
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`${format} image grew past the 4 MiB image limit; ${downscale}`);
  let size: { width: number; height: number };
  try { size = validateImage(data, mime); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/dimensions/.test(message) ? `${format} ${message.replace(/\.$/, "")}; ${downscale}` : `${format} image cannot be sent: ${message}`);
  }
  const ref = await saveImage(ctx.project, data, mime);
  const meta = { path, instructions: await repositoryInstructions(ctx.cwd, dirname(path), true), revision: revision(data), type: mime, ...size, bytes: data.length, attachment_id: ref.id };
  return [{ type: "text", text: JSON.stringify(meta) }, imageBlock(ref)];
}

async function mutate(path: string, expected: unknown, transform: (old: string) => string, create: boolean) {
  const lock = join(paths.runtime, "file-locks", revision(path));
  return withStorageLock(lock, async () => {
    const old = await contents(path).catch(error => { if (create && error.code === "ENOENT") return undefined; throw error; });
    // The current revision makes the retry direct; replacing still names exactly that content (compare-and-swap).
    if (create && old) throw new Error(`file exists (revision ${revision(old)}). To replace all of it, retry write with expected_revision "${revision(old)}"; to change part of it, use edit. Read it first if you have not seen its current content.`);
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

export const read: Tool<ToolResult> = {
  parallel: () => true,
  spec: { name: "read", description: "Read a UTF-8 file in your workspace or saved evidence. Returns numbered lines, a revision for write/edit, and a continuation line. Output is bounded; do not assume the preview is the whole file. Images (png, jpeg, gif, webp; up to 4 MiB and 4096×4096) are returned as images you can see, with their size and an attachment_id; line options do not apply.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 500 } }, required: ["path"] } },
  async run(input, ctx) {
    const path = await filePath(input.path, ctx);
    const image = sniffImage(await head(path));
    if (image && await isImage(path)) return readImage(path, image, ctx);
    const data = await contents(path);
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
  spec: { name: "write", description: "Create a UTF-8 file, or replace it with expected_revision from read. The parent directory must exist. Existing content is never overwritten without a matching revision; writing to an existing path without one fails and reports its current revision, to retry with or to use edit instead.",
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
