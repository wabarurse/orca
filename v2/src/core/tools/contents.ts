import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fail, ok, type Result } from "../../config";
import { sniffImage } from "../../api";

export const MAX_FILE = 2 * 1024 * 1024;
export const revision = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const q = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
export const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

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
export const utf8 = (data: Buffer): boolean => { try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; } };

export async function contents(path: string): Promise<Result<Buffer>> {
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
