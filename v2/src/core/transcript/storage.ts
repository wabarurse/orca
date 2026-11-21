import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RecordFile = {
  write: (buffer: Uint8Array) => Promise<{ bytesWritten: number }>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
  size: () => Promise<number>;
  byteAt: (position: number) => Promise<number | undefined>;
  truncate: (length: number) => Promise<void>;
};
export type Storage = {
  open: (path: string, flags: string) => Promise<RecordFile>;
  read: (path: string) => Promise<Buffer>;
  warn: (message: string) => void;
};
export const APPEND = "a+";
async function openDisk(path: string, flags: string): Promise<RecordFile> {
  const file = await open(path, flags, 0o600);
  return {
    write: buffer => file.write(buffer),
    sync: () => file.sync(),
    close: () => file.close(),
    size: async () => (await file.stat()).size,
    byteAt: async position => {
      const one = new Uint8Array(1);
      return (await file.read(one, 0, 1, position)).bytesRead > 0 ? one[0] : undefined;
    },
    truncate: length => file.truncate(length),
  };
}
export const disk: Storage = { open: openDisk, read: path => readFile(path), warn: message => console.error(message) };

async function writeAll(file: RecordFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes.subarray(offset));
    if (!(bytesWritten > 0 && bytesWritten <= bytes.length - offset)) throw new Error("invalid transcript short write");
    offset += bytesWritten;
  }
}
function warn(io: Storage, message: string): void {
  try { io.warn(message); } catch {}
}
async function syncDirectory(path: string, io: Storage): Promise<void> {
  try {
    const dir = await io.open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) { warn(io, `transcript committed, directory durability uncertain: ${error}`); }
}
async function rollback(file: RecordFile, length: number): Promise<boolean> {
  try { await file.truncate(length); } catch { return false; }
  await file.sync().catch(() => {});
  return true;
}
export async function publish(path: string, record: string, io: Storage = disk, committed: () => void = () => {}, signal?: AbortSignal, authorize?: () => void): Promise<void> {
  signal?.throwIfAborted();
  const file = await io.open(path, APPEND);
  let created = false, done = false;
  try {
    const prior = await file.size();
    created = prior === 0;
    const separator = prior > 0 && await file.byteAt(prior - 1) !== 10 ? "\n" : "";
    signal?.throwIfAborted();
    const bytes = Buffer.from(separator + record + "\n");
    let wrote = false;
    try {
      await writeAll(file, bytes);
      wrote = true;
      await file.sync();
      signal?.throwIfAborted();
      authorize?.();
    } catch (error) {
      const complete = () => wrote ? true : file.size().then(now => now >= prior + bytes.length - 1, () => true);
      if (await rollback(file, prior) || !await complete()) throw error;
      warn(io, `transcript record could not be withdrawn and stays committed, durability uncertain: ${error}`);
    }
    done = true;
    committed();
  } finally {
    await file.close().catch(error => { if (done) warn(io, `transcript committed, close failed: ${error}`); });
  }
  if (created) await syncDirectory(path, io);
}
