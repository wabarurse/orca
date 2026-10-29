// Model-independent image validation: format sniffing, PNG bytes, dimensions,
// scanlines, JPEG/GIF/WebP headers and request-block base64. Provider acceptance
// is determined by the provider.

import { inflateSync } from "node:zlib";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** The image formats both providers accept as input. */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = typeof IMAGE_MIMES[number];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** The image format by magic bytes (never by name), or undefined for anything else. */
export function sniffImage(input: Uint8Array): ImageMime | undefined {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const head = b.toString("latin1", 0, 12);
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
}
const dimensions = (width: number, height: number) => {
  if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw new Error("image dimensions exceed 4096 × 4096.");
  return { width, height };
};
/** JPEG: the first start-of-frame header, walking the marker segments before it. */
function jpegSize(b: Buffer): { width: number; height: number } {
  for (let pos = 2; pos + 4 <= b.length;) {
    if (b[pos] !== 0xff) break;
    const marker = b[pos + 1]!;
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / scan data before any frame header
    const length = b.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > b.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) break;
      return dimensions(b.readUInt16BE(pos + 7), b.readUInt16BE(pos + 5));
    }
    pos += 2 + length;
  }
  throw new Error("invalid jpeg image (no frame header).");
}
/** WebP: the lossy (VP8), lossless (VP8L) or extended (VP8X) header. */
function webpSize(b: Buffer): { width: number; height: number } {
  if (b.length < 30 || b.readUInt32LE(4) + 8 > b.length) throw new Error("truncated webp image.");
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return dimensions(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (chunk === "VP8L" && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
  if (chunk === "VP8X") return dimensions(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  throw new Error("invalid webp image header.");
}
/** PNG is validated structurally (validatePng). JPEG, GIF and WebP are checked by
 * signature, size and header dimensions only; decoding them is the provider's. */
export function validateImage(input: Uint8Array, mime = "image/png"): { width: number; height: number } {
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) throw new Error("unsupported image format; copy a png image (macos also converts tiff/jpeg).");
  const b = Buffer.from(input);
  if (!b.length || b.length > MAX_IMAGE_BYTES) throw new Error("image must be nonempty and at most 4 mib.");
  if (mime !== "image/png" && sniffImage(b) !== mime) throw new Error(`image bytes do not match ${mime}.`);
  if (mime === "image/jpeg") return jpegSize(b);
  if (mime === "image/webp") return webpSize(b);
  if (mime === "image/gif") {
    if (b.length < 14) throw new Error("truncated gif image.");
    return dimensions(b.readUInt16LE(6), b.readUInt16LE(8));
  }
  return validatePng(b);
}
/** PNG: signature, chunk bounds/CRC/order, dimensions, decompression length and
 * scanline filters. No suffix/MIME trust, animated/interlaced inputs rejected. */
function validatePng(b: Buffer): { width: number; height: number } {
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("invalid png image signature.");
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
export function validatedBase64(block: ImageBlockParam): { data: string; mime: ImageMime } {
  if (block.source.type !== "base64" || !IMAGE_MIMES.includes(block.source.media_type)) throw new Error("image was not resolved to supported image bytes; request refused.");
  const data = block.source.data;
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("invalid image base64.");
  validateImage(Buffer.from(data, "base64"), block.source.media_type);
  return { data, mime: block.source.media_type };
}
