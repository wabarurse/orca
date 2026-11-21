import type { ContentBlockParam, ImageBlockParam, MessageParam, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sniffImage, validateImage, type ImageMime } from "../api";
import { fail, ok, paths, type Result } from "../config";

const ID = /^img-[a-f0-9]{16}$/;
const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_REQUEST_IMAGES = 20;
type ResultItem = Exclude<ToolResultBlockParam["content"], string | undefined>[number];

function mapImages(messages: MessageParam[], image: (block: ImageBlockParam) => ImageBlockParam | TextBlockParam, keep: (block: ContentBlockParam) => boolean): MessageParam[] {
  const item = (part: ResultItem): ResultItem => part.type === "image" ? image(part) : part;
  const block = (part: ContentBlockParam): ContentBlockParam => {
    if (part.type === "image") return image(part);
    if (part.type === "tool_result" && Array.isArray(part.content)) return { ...part, content: part.content.map(item) };
    return part;
  };
  return messages.map(message => typeof message.content === "string" ? message : { ...message, content: message.content.filter(keep).map(block) });
}

export async function saveImage(conversation: string, bytes: Uint8Array): Promise<Result<string>> {
  const mime = sniffImage(bytes);
  if (mime === undefined) return fail("not a png, jpeg, gif or webp image");
  const valid = validateImage(bytes, mime);
  if (!valid.ok) return valid;
  const id = `img-${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  await mkdir(paths.images(conversation), { recursive: true, mode: 0o700 });
  await Bun.write(join(paths.images(conversation), `${id}.${EXT[mime]}`), bytes);
  return ok(id);
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

function textPart(text: string): TextBlockParam {
  return { type: "text", text };
}

export function withImages(text: string, ids: string[]): MessageParam["content"] {
  if (ids.length === 0) return text;
  return [textPart(text.length > 0 ? text : "[image-only message]"), ...ids.flatMap(id => [textPart(`[image ${id}]`), imageBlock(id)])];
}

const marker = (id: string | null): TextBlockParam => ({ type: "text", text: `[image ${id ?? "unknown"}: not shown in this request; read it by id to see it again]` });

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
  return mapImages(messages, block => loaded.get(block) ?? block, () => true);
}

export function historicalMessages(messages: MessageParam[]): MessageParam[] {
  return mapImages(messages, block => marker(imageId(block)), block => block.type !== "thinking" && block.type !== "redacted_thinking");
}
