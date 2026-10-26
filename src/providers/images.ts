// Which image blocks a provider admits: PNG validation (signature, chunks,
// dimensions, scanlines), the base64 check on a request block, and the
// vision-model table. Pure; images.ts stores what passes here.

import { inflateSync } from "node:zlib";
import type { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
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
    // Codex catalog input_modalities (same snapshot as docs/MODEL_SETTINGS.md).
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
