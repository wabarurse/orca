/** Validated, project-scoped image references. Disk/transcripts never contain data URIs.
 * Bytes are immutable and retained until project deletion (including after /clear).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import type { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { paths } from "./config";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES = 4;
const MAX_PIXELS = 4096 * 4096;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface ImageRef { readonly id: string; readonly scope: string; readonly sha256: string }
export interface ImageInput { readonly inputId: string; text: string; submission?: string; attachments: ImageRef[] }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function scope(project: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw new Error("invalid image project");
  return hash(`${project}\0${projectIdentity(project)}`);
}
function assertRef(ref: ImageRef): void {
  if (!ref || !UUID.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.scope) || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("invalid image reference");
}
const imageDir = (project: string) => join(paths.project(project), "images");
async function safeDir(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error("unsafe image directory (symlinks are not allowed)");
}
async function readSafe(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) throw new Error("invalid or oversized image storage");
    const bytes = await file.readFile();
    if (bytes.length > max) throw new Error("oversized image storage");
    return bytes;
  } finally { await file.close(); }
}
async function atomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** PNG only: signature, chunk bounds/CRC/order, dimensions, decompression length
 * and scanline filters. No suffix/MIME trust, animated/interlaced inputs rejected.
 */
export function validateImage(input: Uint8Array, mime = "image/png"): { width: number; height: number } {
  if (mime !== "image/png") throw new Error("unsupported image format; copy a png image (macos also converts tiff/jpeg).");
  const b = Buffer.from(input);
  if (!b.length || b.length > MAX_IMAGE_BYTES) throw new Error("image must be nonempty and at most 4 mib.");
  if (!b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid png image signature.");
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, ended = false, palette = false, dataEnded = false;
  const data: Buffer[] = [];
  while (pos + 12 <= b.length) {
    const size = b.readUInt32BE(pos), type = b.toString("ascii", pos + 4, pos + 8), end = pos + size + 12;
    if (end > b.length || crc32(b.subarray(pos + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new Error("invalid png chunk/crc.");
    const value = b.subarray(pos + 8, end - 4);
    if (!width && type !== "IHDR") throw new Error("invalid png header order.");
    if (type === "IHDR") {
      if (pos !== 8 || size !== 13) throw new Error("invalid png header.");
      width = value.readUInt32BE(0); height = value.readUInt32BE(4); depth = value[8]!; color = value[9]!;
      if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw new Error("image dimensions exceed 4096 × 4096.");
      const depths: Record<number, number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
      if (!depths[color]?.includes(depth) || value[10] !== 0 || value[11] !== 0 || value[12] !== 0) throw new Error("unsupported png encoding (interlaced images are not supported).");
    } else if (type === "PLTE") {
      if (data.length || palette || !size || size % 3 || size > 768) throw new Error("invalid png palette.");
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) throw new Error("invalid png data order.");
      data.push(value);
    } else if (type === "IEND") {
      if (size || !data.length || end !== b.length) throw new Error("invalid png end.");
      ended = true; break;
    } else {
      if (data.length) dataEnded = true;
      if (type === "acTL" || !/^[a-z][A-Za-z]{3}$/.test(type)) throw new Error("unsupported png chunk/animation.");
    }
    pos = end;
  }
  if (!ended) throw new Error("truncated png image.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const row = Math.ceil(width * depth * channels / 8) + 1;
  if (row * height > 64 * 1024 * 1024) throw new Error("decoded image exceeds 64 mib.");
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: row * height });
  if (pixels.length !== row * height) throw new Error("invalid png scanline length.");
  for (let y = 0; y < height; y++) if (pixels[y * row]! > 4) throw new Error("invalid png scanline filter.");
  return { width, height };
}
export async function saveImage(project: string, bytes: Uint8Array, mime?: string): Promise<ImageRef> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image must be at most 4 mib.");
  bytes = Buffer.from(bytes); // Caller mutations cannot change bytes after validation/queueing.
  validateImage(bytes, mime);
  const identity = projectIdentity(project), ref = { id: crypto.randomUUID(), scope: scope(project), sha256: hash(bytes) };
  return withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity);
    await safeDir(imageDir(project), true);
    await atomic(join(imageDir(project), `${ref.id}.png`), bytes);
    return ref;
  });
}
export async function loadImage(project: string, ref: ImageRef): Promise<Buffer> {
  assertRef(ref);
  if (ref.scope !== scope(project)) throw new Error("image belongs to another/deleted project.");
  await safeDir(imageDir(project));
  const bytes = await readSafe(join(imageDir(project), `${ref.id}.png`), MAX_IMAGE_BYTES);
  if (hash(bytes) !== ref.sha256) throw new Error(`image ${ref.id} changed or is corrupt.`);
  validateImage(bytes);
  if (ref.scope !== scope(project)) throw new Error("project changed while reading image.");
  return bytes;
}
export async function validateRefs(project: string, refs: ImageRef[] | undefined): Promise<void> {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.length > MAX_IMAGES) throw new Error("at most 4 images may be attached to a prompt.");
  if (new Set(refs.map(r => r?.id)).size !== refs.length) throw new Error("duplicate image reference.");
  for (const ref of refs) await loadImage(project, ref);
}
export function imageBlock(ref: ImageRef): ImageBlockParam {
  assertRef(ref);
  return { type: "image", source: { type: "url", url: `parallels-image:${ref.scope}:${ref.id}:${ref.sha256}` } };
}
export function blockRef(block: ImageBlockParam): ImageRef | undefined {
  if (block.source.type !== "url" || !block.source.url.startsWith("parallels-image:")) return;
  const [, scope, id, sha256, extra] = block.source.url.split(":");
  const ref = { scope: scope!, id: id!, sha256: sha256! };
  if (extra !== undefined) throw new Error("invalid image reference");
  assertRef(ref); return ref;
}
export const imageLabels = (refs?: ImageRef[]) => refs?.length ? refs.map((_, i) => `[image ${i + 1}]`).join(" ") : "";
export function imageContent(text: string, refs: ImageRef[] = []): MessageParam["content"] {
  if (!refs.length) return text;
  return [{ type: "text", text: text || "[Image-only prompt]" }, ...refs.flatMap((ref, i) => [
    { type: "text" as const, text: `[Image ${i + 1}; attachment_id=${ref.id}]` }, imageBlock(ref),
  ])];
}
export async function materializeImages(project: string, messages: MessageParam[]): Promise<MessageParam[]> {
  let total = 0;
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") { out.push(message); continue; }
    const content: Exclude<MessageParam["content"], string> = [];
    for (const block of message.content) {
      if (block.type !== "image") { content.push(block); continue; }
      if (message.role !== "user") throw new Error("assistant image input is unsupported.");
      const ref = blockRef(block);
      if (!ref) throw new Error("unscoped image in saved context; image delivery refused.");
      const bytes = await loadImage(project, ref);
      total += bytes.length;
      if (total > 16 * 1024 * 1024) throw new Error("image context exceeds 16 mib of encoded image bytes. no image was discarded. use an explicit /clear for a new task; original history is preserved.");
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } });
    }
    out.push({ ...message, content });
  }
  return out;
}
/** Explicit capabilities, separate from effort/output settings. Unknown models fail
 * closed. Provider rejection is propagated; no fallback or text-only retry. */
export function requireVision(model: string, messages: MessageParam[]): void {
  if (!messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image"))) return;
  const claude = new Set([
    "claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20240620", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-7-sonnet-20250219",
    "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805",
    "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-5", "claude-opus-4-5-20251101",
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
    "claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-5", "claude-opus-5-5", "claude-haiku-5-5",
  ]).has(model);
  const codex = new Set([
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-5", "gpt-5-mini", "gpt-5-nano",
    "gpt-5-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.2", "gpt-5.2-codex",
    "gpt-5.3-codex", "gpt-5.4", "gpt-5.5",
    // Codex catalog input_modalities (same snapshot as MODEL_SETTINGS.md).
    // Admission is independent of reasoning/fast support and account access.
    "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review",
  ]).has(model);
  if (!claude && !codex) throw new Error(`image input is not enabled for model ${model}. choose a documented vision model explicitly; attachments were preserved.`);
}
export function validatedBase64(block: ImageBlockParam): { data: string; mime: "image/png" } {
  if (block.source.type !== "base64" || block.source.media_type !== "image/png") throw new Error("image was not resolved to supported png bytes; request refused.");
  const data = block.source.data;
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("invalid image base64.");
  validateImage(Buffer.from(data, "base64"), block.source.media_type);
  return { data, mime: "image/png" };
}
// Match inbox FIFO policy: publication order within this process, arbitrary tie
// order between independent processes. Retries keep the first stored timestamp.
let lastStoredTime = 0;
/** Journal image submissions before login/inbox publication. Recovery is manual,
 * never auto-replay; retries keep the exact ID and consumption receipts win. */
export async function saveImageInput(project: string, input: ImageInput): Promise<void> {
  input = { inputId: input.inputId, text: input.text, submission: input.submission, attachments: structuredClone(input.attachments) };
  if (typeof input.text !== "string" || (input.submission !== undefined && typeof input.submission !== "string")) throw new Error("invalid image prompt metadata");
  if (!UUID.test(input.inputId)) throw new Error("invalid image input id");
  const identity = projectIdentity(project);
  await withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity);
    await validateRefs(project, input.attachments);
    if (!input.attachments?.length) throw new Error("image prompt must have an attachment");
    const dir = join(paths.project(project), "image-inputs"); await safeDir(dir, true);
    const path = join(dir, `${input.inputId}.json`), bytes = Buffer.from(JSON.stringify(input));
    if (bytes.length > 65536) throw new Error("image prompt metadata exceeds 64 kib; shorten the text before sending.");
    try {
      const saved = JSON.parse((await readSafe(path, 66560)).toString());
      if (JSON.stringify(saved.input) !== bytes.toString()) throw new Error("image prompt identity is immutable.");
      return;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    lastStoredTime = Math.max(Date.now(), lastStoredTime + 1);
    await atomic(path, Buffer.from(JSON.stringify({ storedAt: new Date(lastStoredTime).toISOString(), input })));
  });
}
export async function pendingImageInputs(project: string, consumed = new Set<string>()): Promise<ImageInput[]> {
  const dir = join(paths.project(project), "image-inputs");
  try { await safeDir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: { storedAt: string; input: ImageInput }[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!UUID.test(id)) throw new Error("invalid image input filename");
    if (consumed.has(id)) continue;
    const saved = JSON.parse((await readSafe(join(dir, name), 66560)).toString()) as { storedAt: string; input: ImageInput };
    const { input, storedAt } = saved;
    if (!input || typeof storedAt !== "string" || !Number.isFinite(Date.parse(storedAt))) throw new Error("invalid saved image prompt");
    if (input.inputId !== id || typeof input.text !== "string" || !Array.isArray(input.attachments) || !input.attachments.length) throw new Error("invalid saved image prompt");
    await validateRefs(project, input.attachments);
    out.push(saved);
  }
  return out.sort((a, b) => a.storedAt.localeCompare(b.storedAt) || a.input.inputId.localeCompare(b.input.inputId)).map(saved => saved.input);
}
