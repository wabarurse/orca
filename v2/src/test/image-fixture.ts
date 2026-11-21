import { deflateSync } from "node:zlib";
/** Real, CRC-valid, deterministic uncompressed-pixel PNG; no clipboard access. */
export function png(width = 1, height = 1, red = 128, pixels?: Uint8Array): Buffer {
  function chunk(type: string, data: Buffer) {
    const bytes = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, check]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scan = pixels ? Buffer.from(pixels) : Buffer.alloc((width * 4 + 1) * height);
  if (!pixels) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 4 + 1) + 1 + x * 4; scan[at] = red; scan[at + 3] = 255; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}
