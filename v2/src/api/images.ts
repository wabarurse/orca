import { inflateSync } from "node:zlib";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { fail, ok, type Result } from "./result";

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = typeof IMAGE_MIMES[number];
type Size = { width: number; height: number };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS: Record<number, number[] | undefined> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS: Record<number, number | undefined> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function imageMime(value: string): ImageMime | undefined {
  return IMAGE_MIMES.find(mime => mime === value);
}

export function sniffImage(input: Uint8Array): ImageMime | undefined {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const head = b.toString("latin1", 0, 12);
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return undefined;
}
const outOfBounds = (width: number, height: number): boolean =>
  width === 0 || height === 0 || width > 4096 || height > 4096 || width * height > MAX_PIXELS;
const dimensions = (width: number, height: number): Result<Size> =>
  outOfBounds(width, height) ? fail("image dimensions exceed 4096 × 4096.") : ok({ width, height });

function jpegSize(b: Buffer): Result<Size> {
  for (let pos = 2; pos + 4 <= b.length;) {
    if (b[pos] !== 0xff) break;
    const marker = b[pos + 1];
    if (marker === undefined) break;
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > b.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) break;
      return dimensions(b.readUInt16BE(pos + 7), b.readUInt16BE(pos + 5));
    }
    pos += 2 + length;
  }
  return fail("invalid jpeg image (no frame header).");
}

function webpSize(b: Buffer): Result<Size> {
  if (b.length < 30 || b.readUInt32LE(4) + 8 > b.length) return fail("truncated webp image.");
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return dimensions(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (chunk === "VP8L" && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
  if (chunk === "VP8X") return dimensions(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return fail("invalid webp image header.");
}

export function checkImage(input: Uint8Array, mime: string = "image/png"): Result<Size> {
  const known = imageMime(mime);
  if (known === undefined) return fail("unsupported image format; copy a png image (macos also converts tiff/jpeg).");
  const b = Buffer.from(input);
  if (b.length === 0 || b.length > MAX_IMAGE_BYTES) return fail("image must be nonempty and at most 64 mib.");
  if (known !== "image/png" && sniffImage(b) !== known) return fail(`image bytes do not match ${known}.`);
  if (known === "image/jpeg") return jpegSize(b);
  if (known === "image/webp") return webpSize(b);
  if (known === "image/gif") {
    if (b.length < 14) return fail("truncated gif image.");
    return dimensions(b.readUInt16LE(6), b.readUInt16LE(8));
  }
  return pngSize(b);
}

export function validateImage(input: Uint8Array, mime = "image/png"): Size {
  const checked = checkImage(input, mime);
  if (!checked.ok) throw new Error(checked.error);
  return checked.data;
}

type PngHeader = { width: number; height: number; depth: number; color: number };

function pngHeader(value: Buffer, pos: number, size: number): Result<PngHeader> {
  if (pos !== 8 || size !== 13) return fail("invalid png header.");
  const width = value.readUInt32BE(0), height = value.readUInt32BE(4), depth = value[8] ?? 0, color = value[9] ?? 0;
  if (outOfBounds(width, height)) return fail("image dimensions exceed 4096 × 4096.");
  if (PNG_DEPTHS[color]?.includes(depth) !== true || value[10] !== 0 || value[11] !== 0 || value[12] !== 0) return fail("unsupported png encoding (interlaced images are not supported).");
  return ok({ width, height, depth, color });
}

function pngSize(b: Buffer): Result<Size> {
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return fail("invalid png image signature.");
  let pos = 8, header: PngHeader | undefined, ended = false, palette = false, dataEnded = false;
  const data: Buffer[] = [];
  while (pos + 12 <= b.length) {
    const size = b.readUInt32BE(pos), type = b.toString("ascii", pos + 4, pos + 8), end = pos + size + 12;
    if (end > b.length || crc32(b.subarray(pos + 4, end - 4)) !== b.readUInt32BE(end - 4)) return fail("invalid png chunk/crc.");
    const value = b.subarray(pos + 8, end - 4);
    if (header === undefined && type !== "IHDR") return fail("invalid png header order.");
    if (type === "IHDR") {
      const parsed = pngHeader(value, pos, size);
      if (!parsed.ok) return parsed;
      header = parsed.data;
    } else if (type === "PLTE") {
      if (data.length > 0 || palette || size === 0 || size % 3 !== 0 || size > 768) return fail("invalid png palette.");
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (header?.color === 3 && !palette)) return fail("invalid png data order.");
      data.push(value);
    } else if (type === "IEND") {
      if (size !== 0 || data.length === 0 || end !== b.length) return fail("invalid png end.");
      ended = true; break;
    } else {
      if (data.length > 0) dataEnded = true;
      if (type === "acTL" || !/^[a-z][A-Za-z]{3}$/.test(type)) return fail("unsupported png chunk/animation.");
    }
    pos = end;
  }
  if (!ended || header === undefined) return fail("truncated png image.");
  const { width, height, depth, color } = header;
  const channels = PNG_CHANNELS[color] ?? 1;
  const row = Math.ceil(width * depth * channels / 8) + 1;
  if (row * height > 64 * 1024 * 1024) return fail("decoded image exceeds 64 mib.");
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: row * height }); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (pixels.length !== row * height) return fail("invalid png scanline length.");
  for (let y = 0; y < height; y++) if ((pixels[y * row] ?? 0) > 4) return fail("invalid png scanline filter.");
  return ok({ width, height });
}

export function validatedBase64(block: ImageBlockParam): Result<{ data: string; mime: ImageMime }> {
  if (block.source.type !== "base64") return fail("image was not resolved to supported image bytes; request refused.");
  const mime = imageMime(block.source.media_type);
  if (mime === undefined) return fail("image was not resolved to supported image bytes; request refused.");
  const data = block.source.data;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length === 0 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) {
    return fail("invalid image base64.");
  }
  const checked = checkImage(Buffer.from(data, "base64"), mime);
  if (!checked.ok) return checked;
  return ok({ data, mime });
}
