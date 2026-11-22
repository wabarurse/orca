import { lstat, open, readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { asRecord, errorMessage, fail, ok, type Result } from "../../config";
import { MAX_IMAGE_BYTES, sniffImage, validateImage, type ImageMime } from "../../api";
import { imageBlock, imageFile, saveImage } from "../images";
import { repositoryInstructions } from "../instructions";
import { contents, MAX_FILE, mib, q, revision, utf8 } from "./contents";
import { filePath } from "./path";
import { settled, type Tool, type ToolContext, type ToolResult } from "./registry";

async function head(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try { const bytes = Buffer.alloc(16); const { bytesRead } = await file.read(bytes, 0, 16, 0); return bytes.subarray(0, bytesRead); }
  finally { await file.close(); }
}

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
  const size = validateImage(data, mime);
  if (!size.ok) return fail(/dimensions/.test(size.error) ? `${format} ${size.error.replace(/\.$/, "")}; ${downscale}` : `${format} image cannot be sent: ${size.error}`);
  const id = await saveImage(ctx.conversation, data);
  if (!id.ok) return fail(`${format} image cannot be saved: ${id.error}`);
  const meta = { path, revision: revision(data), type: mime, ...size.data, bytes: data.length, image_id: id.data };
  return ok([{ type: "text", text: JSON.stringify(meta) }, imageBlock(id.data)]);
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
