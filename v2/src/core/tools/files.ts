import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../../config";
import { MAX_IMAGE_BYTES, sniffImage, validateImage, type ImageMime } from "../../api";
import { withStorageLock } from "../lock";
import { imageBlock, imageFile, saveImage } from "../images";
import { repositoryInstructions } from "../instructions";
import { asRecord, errorCode, errorMessage, fail, ok, type Result } from "../result";
import { settled, type Tool, type ToolContext, type ToolResult } from "./registry";

const MAX_FILE = 2 * 1024 * 1024;
const BUILTIN_PLUGINS = resolve(import.meta.dir, "../../plugins");
const revision = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
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

async function head(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(16); const { bytesRead } = await file.read(bytes, 0, 16, 0); return bytes.subarray(0, bytesRead); }
  finally { await file.close(); }
}
const q = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
const BINARIES: { name: string; test: (b: Buffer) => boolean; hint: (path: string) => string }[] = [
  { name: "pdf", test: b => b.toString("latin1", 0, 5) === "%PDF-", hint: p => `pdftotext ${q(p)} - | head -200` },
  { name: "zip archive", test: b => b.toString("latin1", 0, 4) === "PK\x03\x04", hint: p => `unzip -l ${q(p)}` },
  { name: "gzip archive", test: b => b[0] === 0x1f && b[1] === 0x8b, hint: p => `gzip -dc ${q(p)} | head -200` },
  { name: "sqlite database", test: b => b.toString("latin1", 0, 15) === "SQLite format 3", hint: p => `sqlite3 -readonly ${q(p)} .schema` },
  { name: "tiff/bmp/heic image", test: b => ["II*\0", "MM\0*"].includes(b.toString("latin1", 0, 4)) || b.toString("latin1", 0, 2) === "BM" || /^ftyp(heic|heix|mif1)/.test(b.toString("latin1", 4, 12)),
    hint: p => `sips -s format png ${q(p)} --out /tmp/converted.png (macOS), then read the png` },
  { name: "executable", test: b => b.toString("latin1", 0, 4) === "\x7fELF" || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(b.length >= 4 ? b.readUInt32BE(0) : 0), hint: p => `file ${q(p)}; strings ${q(p)} | head -100` },
];
function binary(path: string, start: Buffer): string {
  const image = sniffImage(start), known = BINARIES.find(b => b.test(start));
  if (image !== undefined) return `binary file (${image.slice(6)} image); read returns it as an image, but it cannot be changed as text`;
  return known !== undefined ? `binary file (${known.name}); use a command such as \`${known.hint(path)}\``
    : `binary file (unknown type); inspect it with a bounded command such as \`file ${q(path)}; xxd ${q(path)} | head -40\``;
}
const utf8 = (data: Buffer): boolean => { try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; } };
async function contents(path: string): Promise<Result<Buffer>> {
  const s = await lstat(path);
  if (!s.isFile()) return fail("path is not a regular file");
  if (s.size > MAX_FILE) return fail(`file is ${mib(s.size)}, over the 2 MiB read limit; read a range with a bounded command such as \`sed -n '1,200p' ${q(path)}\``);
  const data = await readFile(path);
  if (data.length > MAX_FILE) return fail("file grew past the 2 MiB read limit; read a range with a bounded command");
  const start = data.subarray(0, 16);
  if (data.includes(0)) return fail(binary(path, start));
  if (!utf8(data)) {
    if (sniffImage(start) !== undefined || BINARIES.some(b => b.test(start))) return fail(binary(path, start));
    return fail(`file is not UTF-8; use an encoding-aware command such as \`iconv -f latin1 -t utf-8 ${q(path)} | head -200\``);
  }
  return ok(data);
}
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const isText = (data: Buffer) => !data.includes(0) && utf8(data);
async function isImage(path: string): Promise<boolean> {
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const s = await lstat(path);
  return s.size > MAX_FILE || !isText(await readFile(path));
}
async function readImage(path: string, mime: ImageMime, ctx: ToolContext): Promise<Result<ToolResult>> {
  const format = mime.slice(6), small = path.slice(0, path.length - extname(path).length) + `-small${extname(path) !== "" ? extname(path) : ".png"}`;
  const downscale = `downscale a copy and read that, e.g. \`sips -Z 1568 ${q(path)} --out ${q(small)}\` (macOS) or \`magick ${q(path)} -resize 1568x1568 ${q(small)}\``;
  const s = await lstat(path);
  if (s.size > MAX_IMAGE_BYTES) return fail(`${format} image is ${mib(s.size)}, over the 64 MiB image memory limit; ${downscale}`);
  const data = await readFile(path);
  if (data.length > MAX_IMAGE_BYTES) return fail(`${format} image grew past the 64 MiB image memory limit; ${downscale}`);
  let size: { width: number; height: number };
  try { size = validateImage(data, mime); }
  catch (error) {
    const message = errorMessage(error);
    return fail(/dimensions/.test(message) ? `${format} ${message.replace(/\.$/, "")}; ${downscale}` : `${format} image cannot be sent: ${message}`);
  }
  const id = await saveImage(ctx.conversation, data);
  const meta = { path, revision: revision(data), type: mime, ...size, bytes: data.length, image_id: id };
  return ok([{ type: "text", text: JSON.stringify(meta) }, imageBlock(id)]);
}

export type Change = { text: string; report: Record<string, unknown> };

export async function mutate(path: string, expected: unknown, transform: (old: string) => Result<Change>, create: boolean): Promise<Result<string>> {
  const lock = join(paths.runtime, "file-locks", revision(path));
  return withStorageLock(lock, async (): Promise<Result<string>> => {
    const read = await contents(path).catch((error: unknown) => { if (create && errorCode(error) === "ENOENT") return null; throw error; });
    if (read !== null && !read.ok) return read;
    const old = read === null ? null : read.data;
    if (create && old !== null) return fail(`file exists (revision ${revision(old)}). To replace all of it, retry write with expected_revision "${revision(old)}"; to change part of it, use edit. Read it first if you have not seen its current content.`);
    const seen = old !== null ? revision(old) : null;
    if (!create && expected !== undefined && seen !== expected) return fail(`file changed: expected_revision does not match the current revision "${seen ?? "none"}"; nothing was changed. Check the current content before retrying.`);
    const change = transform(old?.toString("utf8") ?? "");
    if (!change.ok) return change;
    const { text: next, report } = change.data;
    if (Buffer.byteLength(next) > MAX_FILE) return fail("write exceeds 2 MiB");
    const staged = join(dirname(path), `.orca2-write-${crypto.randomUUID()}`);
    try {
      await writeFile(staged, next, { flag: "wx", mode: 0o600 });
      if (old !== null) {
        const s = await lstat(path);
        if (!s.isFile() || s.isSymbolicLink() || revision(await readFile(path)) !== seen) return fail("file changed during edit; no changes applied");
        await chmod(staged, s.mode & 0o777);
        await rename(staged, path);
      } else await link(staged, path);
    } finally { await unlink(staged).catch(() => {}); }
    return ok(JSON.stringify({ path, revision: revision(next), bytes: Buffer.byteLength(next), previous_revision: seen, ...report }));
  });
}

const PREVIEW_BYTES = 1000, PREVIEW_LINE_BYTES = 200;
const lineAt = (text: string, offset: number) => { let n = 1; for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++; return n; };
const clip = (line: string) => Buffer.byteLength(line) <= PREVIEW_LINE_BYTES ? line
  : Buffer.from(line).subarray(0, PREVIEW_LINE_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "…";
export function editPreview(text: string, regions: { start: number; end: number }[]): string {
  const lines = text.split("\n"), out: string[] = [];
  let bytes = 0, last = 0, shown = 0;
  for (const region of regions) {
    const from = Math.max(1, lineAt(text, region.start) - 1), to = Math.min(lines.length, lineAt(text, region.end) + 1);
    for (let n = Math.max(from, last + 1); n <= to; n++) {
      const row = `${n}: ${clip(lines[n - 1] ?? "")}`, gap = last > 0 && n > last + 1 ? "…\n" : "";
      if (bytes + Buffer.byteLength(gap + row) + 1 > PREVIEW_BYTES) {
        return [...out, `[preview truncated before line ${n}; ${shown} of ${regions.length} changed region${regions.length === 1 ? "" : "s"} shown in full]`].join("\n");
      }
      if (gap !== "") out.push("…");
      out.push(row); bytes += Buffer.byteLength(gap + row) + 1; last = n;
    }
    shown++;
  }
  return out.join("\n");
}
function occurrences(text: string, needle: string, step: number): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + step)) found.push(i);
  return found;
}
const some = (numbers: number[], max = 12) => numbers.slice(0, max).join(", ") + (numbers.length > max ? ", …" : "");
function noMatch(text: string, old: string): string {
  const wanted = old.split("\n").map(l => l.trim()).find(l => l !== ""), lines = text.split("\n");
  const near = wanted !== undefined ? lines.flatMap((l, i) => l.trim() === wanted ? [i + 1] : []) : [];
  const first = near[0];
  const where = first === undefined ? "" : ` Its first line appears, with different whitespace or different following lines, at line ${some(near, 5)}: ${JSON.stringify(clip(lines[first - 1] ?? ""))}.`;
  return `old_text not found (0 matches); nothing was changed. It must match the file exactly, including whitespace and indentation.${where}`;
}

const readRange = { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 500 } };

type TextRead = { path: string; instructions: string; revision: string; total_lines: number; content: string; next_line: number | null };

async function readText(path: string, input: Record<string, unknown>, ctx: ToolContext, cap = 12000): Promise<Result<TextRead>> {
  const read = await contents(path);
  if (!read.ok) return read;
  const data = read.data;
  const start = input.start_line ?? 1, count = input.lines ?? 150;
  if (typeof start !== "number" || typeof count !== "number" || !Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 500) return fail("invalid line range");
  const lines = data.toString("utf8").split("\n"), selected: string[] = [];
  let bytes = 0, i = start - 1;
  for (; i < Math.min(lines.length, start - 1 + count); i++) {
    const line = `${i + 1}: ${lines[i] ?? ""}`;
    if (bytes + Buffer.byteLength(line) > cap) break;
    selected.push(line); bytes += Buffer.byteLength(line) + 1;
  }
  if (selected.length === 0 && i < lines.length) return fail("line exceeds read preview budget; use a single-file read or a bounded shell command");
  return ok({ path, instructions: ctx.trusted ? await repositoryInstructions(ctx.cwd, dirname(path), true) : "", revision: revision(data), total_lines: lines.length,
    content: selected.join("\n"), next_line: i < lines.length ? i + 1 : null });
}

export const read: Tool = {
  parallel: () => true,
  spec: { name: "read", description: "Read UTF-8 files in your workspace or saved evidence. When you already know several files or ranges you need, send them together in files (up to four text ranges), or use path for a single file. Returns numbered lines, a revision (write needs it to replace a file; edit does not) and continuation lines. Output is bounded. For images (png, jpeg, gif, webp; up to 64 MiB and 4096×4096), use path alone to get an image and attachment_id. Use image_id alone to see an image of this conversation again (a pasted one, or one shown by id in a summary).",
    input_schema: { type: "object", properties: {
      ...readRange,
      image_id: { type: "string", description: "An image id of this conversation (img-…); mutually exclusive with path, files and line ranges." },
      files: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: readRange, required: ["path"] } },
    } } },
  async run(input, ctx) {
    if (input.image_id !== undefined) {
      if ([input.path, input.files, input.start_line, input.lines].some(v => v !== undefined)) throw new Error("use image_id alone, or path/files with optional line ranges");
      if (typeof input.image_id !== "string") throw new Error("image_id must be a string");
      const id = input.image_id;
      if (imageFile(ctx.conversation, id) === null) throw new Error(`no image ${id} in this conversation`);
      return [{ type: "text", text: JSON.stringify({ image_id: id }) }, imageBlock(id)];
    }
    if (input.files === undefined) {
      const path = settled(await filePath(input.path, ctx));
      const image = sniffImage(await head(path));
      if (image !== undefined && await isImage(path)) return settled(await readImage(path, image, ctx));
      return JSON.stringify(settled(await readText(path, input, ctx)));
    }
    const { files } = input;
    if (input.path !== undefined || input.start_line !== undefined || input.lines !== undefined) throw new Error("use either files or a single path with its range");
    if (!Array.isArray(files) || files.length < 1 || files.length > 4) throw new Error("files requires one to four text ranges");
    const instructions: string[] = [];
    const results: unknown[] = [];
    for (const item of files) {
      ctx.signal.throwIfAborted();
      const range = asRecord(item);
      if (range === null) throw new Error("each file range must be an object");
      try {
        const path = await filePath(range.path, ctx);
        const read = path.ok ? await readText(path.data, range, ctx, Math.floor(12000 / files.length)) : path;
        if (!read.ok) { results.push({ path: range.path, error: read.error }); continue; }
        const { instructions: rules, ...result } = read.data;
        if (rules !== "" && !instructions.includes(rules)) instructions.push(rules);
        results.push({ ...result, instructions_index: rules !== "" ? instructions.indexOf(rules) : null });
      } catch (error) {
        results.push({ path: range.path, error: errorMessage(error) });
      }
    }
    if (instructions.join("").length > 16000) throw new Error("combined repository instructions exceed the batch budget; read these files individually");
    return JSON.stringify({ files: results, instructions });
  },
};

export const write: Tool = {
  parallel: () => false,
  spec: { name: "write", description: "Create a UTF-8 file, or replace it with expected_revision from read. The parent directory must exist. Existing content is never overwritten without a matching revision; writing to an existing path without one fails and reports its current revision, to retry with or to use edit instead.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expected_revision: { type: "string" } }, required: ["path", "content"] } },
  async run(input, ctx) {
    if (typeof input.content !== "string") throw new Error("content must be a string");
    const text = input.content;
    return settled(await mutate(settled(await filePath(input.path, ctx, true)), input.expected_revision, () => ok({ text, report: {} }), input.expected_revision === undefined));
  },
};

export const edit: Tool = {
  parallel: () => false,
  spec: { name: "edit", description: "Change a UTF-8 file by exact text replacement, in one call: no prior read or revision is needed, the exact match of old_text is the check. old_text must match exactly one location unless replace_all is true; a failure changes nothing and names the matching lines. Returns a numbered preview of the changed lines, so there is no need to re-read.",
    input_schema: { type: "object", properties: {
      path: { type: "string" },
      old_text: { type: "string", description: "Exact text to replace, with its whitespace; include enough surrounding text to be unique." },
      new_text: { type: "string" },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_text instead of requiring a single match. Default false." },
      expected_revision: { type: "string", description: "Optional revision from read; when given, the edit is refused if the file has changed since." },
    }, required: ["path", "old_text", "new_text"] } },
  async run(input, ctx) {
    if (typeof input.old_text !== "string" || input.old_text === "" || typeof input.new_text !== "string") throw new Error("old_text must be nonempty; new_text must be a string");
    if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") throw new Error("replace_all must be a boolean");
    if (input.expected_revision !== undefined && typeof input.expected_revision !== "string") throw new Error("expected_revision must be a string when given");
    const old = input.old_text, next = input.new_text, all = input.replace_all === true;
    if (old === next) throw new Error("old_text and new_text are identical; nothing to change");
    return settled(await mutate(settled(await filePath(input.path, ctx, true)), input.expected_revision, (text): Result<Change> => {
      const found = occurrences(text, old, all ? old.length : 1);
      if (found.length === 0) return fail(noMatch(text, old));
      if (found.length > 1 && !all) return fail(`old_text matches ${found.length} locations (lines ${some(found.map(i => lineAt(text, i)))}); nothing was changed. Add surrounding text so it matches one, or set replace_all to true to replace all ${found.length}.`);
      let result = "", at = 0;
      const regions = found.map(i => { result += text.slice(at, i); const start = result.length; result += next; at = i + old.length; return { start, end: result.length }; });
      result += text.slice(at);
      return ok({ text: result, report: { ...(all ? { replacements: found.length } : {}), preview: editPreview(result, regions) } });
    }, false));
  },
};
