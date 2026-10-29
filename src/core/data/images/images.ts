/** Validated, project-scoped image references. Disk/transcripts never contain data URIs.
 * Bytes are immutable and retained until project deletion (including after /clear).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImageBlockParam, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { paths } from "../../../config";
import { legacy } from "../../../config";
import { MAX_IMAGE_BYTES, validateImage, type ImageMime } from "../../../providers";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "../projects";
import type { ImageInput, ImageRef } from "../../../protocol";

export const MAX_IMAGES = 4;
/** Encoded image bytes one model request may carry. */
const MAX_CONTEXT_IMAGE_BYTES = 16 * 1024 * 1024;
/** Images one request may carry: past 20, Anthropic shrinks every image's limit to
 * 2000 px (so a 4096 px screenshot fails) and refuses more than 100 outright. */
const MAX_CONTEXT_IMAGES = 20;
/** Stored file extension per format; PNG first (clipboard images and every older store). */
const EXTENSIONS: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
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
export async function saveImage(project: string, bytes: Uint8Array, mime = "image/png"): Promise<ImageRef> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image must be at most 4 mib.");
  bytes = Buffer.from(bytes); // Caller mutations cannot change bytes after validation/queueing.
  validateImage(bytes, mime);
  const identity = projectIdentity(project), ref = { id: crypto.randomUUID(), scope: scope(project), sha256: hash(bytes) };
  return withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity);
    await safeDir(imageDir(project), true);
    await atomic(join(imageDir(project), `${ref.id}.${EXTENSIONS[mime as ImageMime]}`), bytes);
    return ref;
  });
}
/** The stored bytes and their format. The extension is a lookup aid; the format is
 * the bytes' own (sniffed) and must agree with it. */
async function readStored(project: string, id: string): Promise<{ bytes: Buffer; mime: ImageMime }> {
  for (const [mime, extension] of Object.entries(EXTENSIONS) as [ImageMime, string][]) {
    let bytes: Buffer;
    try { bytes = await readSafe(join(imageDir(project), `${id}.${extension}`), MAX_IMAGE_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    return { bytes, mime };
  }
  throw Object.assign(new Error(`image ${id} is missing from the project image store.`), { code: "ENOENT" });
}
export async function loadImage(project: string, ref: ImageRef): Promise<Buffer> {
  return (await loadTypedImage(project, ref)).bytes;
}
async function loadTypedImage(project: string, ref: ImageRef): Promise<{ bytes: Buffer; mime: ImageMime }> {
  assertRef(ref);
  if (ref.scope !== scope(project)) throw new Error("image belongs to another/deleted project.");
  await safeDir(imageDir(project));
  const { bytes, mime } = await readStored(project, ref.id);
  if (hash(bytes) !== ref.sha256) throw new Error(`image ${ref.id} changed or is corrupt.`);
  validateImage(bytes, mime);
  if (ref.scope !== scope(project)) throw new Error("project changed while reading image.");
  return { bytes, mime };
}
export async function validateRefs(project: string, refs: ImageRef[] | undefined): Promise<void> {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.length > MAX_IMAGES) throw new Error("at most 4 images may be attached to a prompt.");
  if (new Set(refs.map(r => r?.id)).size !== refs.length) throw new Error("duplicate image reference.");
  for (const ref of refs) await loadImage(project, ref);
}
export function imageBlock(ref: ImageRef): ImageBlockParam {
  assertRef(ref);
  return { type: "image", source: { type: "url", url: `orca-image:${ref.scope}:${ref.id}:${ref.sha256}` } };
}
export function blockRef(block: ImageBlockParam): ImageRef | undefined {
  if (block.source.type !== "url" || !(block.source.url.startsWith("orca-image:") || block.source.url.startsWith(legacy.imagePrefix))) return;
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
/** Scoped references become base64 blocks just before a request. Prompt images are
 * never dropped: over the cap the request is refused. Images a tool read (`read`;
 * nested in a tool_result, their file can be read again) fill what remains, in bytes
 * and in count, newest first; older ones give way to a text note instead of blocking
 * the agent. Prompt images keep their policy: the count cap only limits tool images. */
export async function materializeImages(project: string, messages: MessageParam[]): Promise<MessageParam[]> {
  const loaded = new Map<ImageBlockParam, { bytes: Buffer; mime: ImageMime }>();
  const load = async (block: ImageBlockParam): Promise<number> => {
    const ref = blockRef(block);
    if (!ref) throw new Error("unscoped image in saved context; image delivery refused.");
    const image = await loadTypedImage(project, ref);
    loaded.set(block, image);
    return image.bytes.length;
  };
  let total = 0, count = 0;
  const toolImages: ImageBlockParam[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && message.role === "user" && Array.isArray(block.content)) {
        for (const item of block.content) if (item.type === "image") toolImages.push(item);
      }
      if (block.type !== "image") continue;
      if (message.role !== "user") throw new Error("assistant image input is unsupported.");
      total += await load(block); count++;
      if (total > MAX_CONTEXT_IMAGE_BYTES) throw new Error("image context exceeds 16 mib of encoded image bytes. no image was discarded. use an explicit /clear for a new task; original history is preserved.");
    }
  }
  // Newest first; the first tool image that does not fit ends the fill, so what is
  // delivered is always the newest run (an older image never displaces a newer one).
  for (const block of toolImages.reverse()) {
    if (count >= MAX_CONTEXT_IMAGES) break;
    const size = await load(block);
    if (total + size > MAX_CONTEXT_IMAGE_BYTES) { loaded.delete(block); break; }
    total += size; count++;
  }
  const deliver = (block: ImageBlockParam): ImageBlockParam | TextBlockParam => {
    const image = loaded.get(block);
    if (image) return { type: "image", source: { type: "base64", media_type: image.mime, data: image.bytes.toString("base64") } };
    return { type: "text", text: `[Image omitted from this request: this context's images exceed the request limit (${MAX_CONTEXT_IMAGES} images or 16 MiB) (attachment_id=${blockRef(block)?.id ?? "unknown"}). Read the file again to inspect it.]` };
  };
  return messages.map(message => typeof message.content === "string" ? message : { ...message, content: message.content.map(block =>
    block.type === "image" && message.role === "user" ? deliver(block)
    : block.type === "tool_result" && message.role === "user" && Array.isArray(block.content) ? { ...block, content: block.content.map(item => item.type === "image" ? deliver(item) : item) }
    : block) });
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
    const dir = join(paths.project(project), "images", "inputs"); await safeDir(dir, true);
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
  const dir = join(paths.project(project), "images", "inputs");
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
