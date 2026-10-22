import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";

const RETENTION_MS = 7 * 86400_000;
const STORED_BYTES = 256 * 1024 * 1024;
const filename = /^[0-9a-f-]{36}\.(txt|partial|running)$/;

/** Completed outputs are bounded by age/space. Live files are excluded until stale. */
export async function pruneOutputs(dir: string, now = Date.now(), byteLimit = STORED_BYTES): Promise<void> {
  const entries = await readdir(dir);
  const files = (await Promise.all(entries.filter(name => filename.test(name)).map(async name => {
    const path = join(dir, name);
    try { const s = await stat(path); return s.isFile() ? { name, path, bytes: s.size, time: s.mtimeMs } : null; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }))).filter(f => f !== null).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  let total = 0;
  for (const f of files) {
    if (f.name.endsWith(".running") && now - f.time < RETENTION_MS) continue;
    total += f.bytes;
    if (now - f.time > RETENTION_MS || total > byteLimit) await unlink(f.path).catch(e => { if (e.code !== "ENOENT") throw e; });
  }
}

/** Exclusive private file outside the repository, with a distinct incomplete state. */
export async function outputArtifact(project: string) {
  const dir = join(paths.project(project), "tool-outputs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Storage failure must be reported before starting a command with side effects.
  await pruneOutputs(dir);
  const stem = join(dir, crypto.randomUUID());
  const running = `${stem}.running`;
  const file = await open(running, "wx", 0o600);
  return {
    partialPath: `${stem}.partial`,
    async write(bytes: Uint8Array) {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error("Could not save tool output");
        offset += bytesWritten;
      }
    },
    async finish(complete: boolean) {
      await file.close();
      const path = `${stem}.${complete ? "txt" : "partial"}`;
      await rename(running, path);
      // Only clean before the next command; the file just returned stays available.
      return path;
    },
  };
}

/** Bounded head/tail storage; no full-output string is built in memory. */
export class OutputPreview {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  bytes = 0;
  constructor(private capacity: number) {}
  add(chunk: Uint8Array) {
    this.bytes += chunk.length;
    if (this.head.length < this.capacity) this.head = Buffer.concat([this.head, chunk.subarray(0, this.capacity - this.head.length)]);
    this.tail = Buffer.concat([this.tail, chunk.subarray(Math.max(0, chunk.length - this.capacity))]).subarray(-this.capacity);
  }
  fits(max: number, footer = ""): boolean {
    return this.bytes <= this.head.length && Buffer.byteLength(this.head.toString("utf8") + footer) <= max;
  }
  render(max: number, footer: string): string {
    if (Buffer.byteLength(footer) + 80 > max) throw new Error("Tool output metadata exceeds preview budget; increase maxToolResultBytes");
    if (this.fits(max, footer)) return this.head.toString("utf8") + footer;
    const marker = `\n...[truncated; ${this.bytes} output bytes]...\n`;
    const available = Math.max(0, max - Buffer.byteLength(marker + footer));
    return utf8Head(this.head, Math.ceil(available / 2)) + marker + utf8Tail(this.tail, Math.floor(available / 2)) + footer;
  }
}
function utf8Head(bytes: Uint8Array, n: number): string {
  const decoded = new TextDecoder().decode(bytes.subarray(0, n), { stream: true });
  return new TextDecoder().decode(Buffer.from(decoded).subarray(0, n), { stream: true });
}
function utf8Tail(bytes: Uint8Array, n: number): string {
  let start = Math.max(0, bytes.length - n);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const decoded = Buffer.from(new TextDecoder().decode(bytes.subarray(start)));
  let offset = Math.max(0, decoded.length - n);
  while (offset < decoded.length && (decoded[offset]! & 0xc0) === 0x80) offset++;
  return decoded.subarray(offset).toString();
}
