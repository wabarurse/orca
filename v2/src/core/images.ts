// Images a conversation holds (pasted with Ctrl+V, read by a tool, returned by MCP): stored once under images/<id>,
// referenced from transcripts as `orca-image:<id>` and turned into base64 just before a request.
import type { ImageBlockParam, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sniffImage, validateImage, type ImageMime } from "../api";
import { paths } from "../config";

const ID = /^img-[a-f0-9]{16}$/;
const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** The most images one request carries; older ones become text markers (read the id again to see one). */
export const MAX_REQUEST_IMAGES = 20;

export async function saveImage(conversation: string, bytes: Uint8Array): Promise<string> {
  const mime = sniffImage(bytes);
  if (mime === undefined) throw new Error("not a png, jpeg, gif or webp image");
  validateImage(bytes, mime);
  const id = `img-${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  await mkdir(paths.images(conversation), { recursive: true, mode: 0o700 });
  await Bun.write(join(paths.images(conversation), `${id}.${EXT[mime]}`), bytes);
  return id;
}

export function imageFile(conversation: string, id: string): string | null {
  if (!ID.test(id)) return null;
  for (const ext of Object.values(EXT)) {
    const file = join(paths.images(conversation), `${id}.${ext}`);
    if (Bun.file(file).size > 0) return file;
  }
  return null;
}

export const imageBlock = (id: string): ImageBlockParam => ({ type: "image", source: { type: "url", url: `orca-image:${id}` } });
export const imageId = (block: ImageBlockParam): string | null =>
  block.source.type === "url" && block.source.url.startsWith("orca-image:") ? block.source.url.slice("orca-image:".length) : null;

/** A user turn's content: its text, then each image with a line naming its id. */
export function withImages(text: string, ids: string[]): MessageParam["content"] {
  if (ids.length === 0) return text;
  return [{ type: "text", text: text.length > 0 ? text : "[image-only message]" }, ...ids.flatMap(id => [{ type: "text" as const, text: `[image ${id}]` }, imageBlock(id)])];
}

const marker = (id: string | null): TextBlockParam => ({ type: "text", text: `[image ${id ?? "unknown"}: not shown in this request; read it by id to see it again]` });

/** References become base64, newest first up to the cap; the rest become markers. */
export async function materialize(conversation: string, messages: MessageParam[]): Promise<MessageParam[]> {
  const blocks: ImageBlockParam[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image") blocks.push(block);
      if (block.type === "tool_result" && Array.isArray(block.content)) for (const item of block.content) if (item.type === "image") blocks.push(item);
    }
  }
  const keep = new Set(blocks.slice(-MAX_REQUEST_IMAGES));
  const loaded = new Map<ImageBlockParam, ImageBlockParam | TextBlockParam>();
  for (const block of blocks) {
    const id = imageId(block);
    if (id === null) { loaded.set(block, block); continue; }
    const file = keep.has(block) ? imageFile(conversation, id) : null;
    if (file === null) { loaded.set(block, marker(id)); continue; }
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const mime = sniffImage(bytes) ?? "image/png";
    loaded.set(block, { type: "image", source: { type: "base64", media_type: mime, data: Buffer.from(bytes).toString("base64") } });
  }
  const swap = <T extends { type: string }>(block: T): T | ImageBlockParam | TextBlockParam => block.type === "image" ? loaded.get(block as unknown as ImageBlockParam) ?? block : block;
  return messages.map(message => typeof message.content === "string" ? message : { ...message, content: message.content.map(block =>
    block.type === "tool_result" && Array.isArray(block.content) ? { ...block, content: block.content.map(item => swap(item) as typeof item) } : swap(block) as typeof block) });
}

/** Messages with every image as a text marker: what summaries and the archive see. */
export function historicalMessages(messages: MessageParam[]): MessageParam[] {
  const plain = <T extends { type: string }>(block: T): T | TextBlockParam => block.type === "image" ? marker(imageId(block as unknown as ImageBlockParam)) : block;
  return messages.map(message => typeof message.content === "string" ? message : { ...message, content: message.content
    .filter(block => block.type !== "thinking" && block.type !== "redacted_thinking")
    .map(block => block.type === "tool_result" && Array.isArray(block.content) ? { ...block, content: block.content.map(item => plain(item) as typeof item) } : plain(block) as typeof block) });
}
