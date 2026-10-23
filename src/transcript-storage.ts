import { open, rename, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RecordFile {
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface Storage {
  open(path: string, flags: string): Promise<RecordFile>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<unknown>;
  read(path: string): Promise<Buffer>;
  warn(message: string): void;
}
export const disk: Storage = { open: (path, flags) => open(path, flags, 0o600), rename, unlink, read: path => readFile(path), warn: message => console.error(message) };

async function writeAll(file: RecordFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes.subarray(offset));
    if (!(bytesWritten > 0 && bytesWritten <= bytes.length - offset)) throw new Error("invalid transcript short write");
    offset += bytesWritten;
  }
}
async function stage(path: string, bytes: Uint8Array, io: Storage): Promise<void> {
  const file = await io.open(path, "wx");
  try { await writeAll(file, bytes); await file.sync(); }
  finally { await file.close(); }
}
async function syncDirectory(path: string, io: Storage): Promise<void> {
  try {
    const dir = await io.open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    // Publication already committed: never report this as an uncommitted append.
    try { io.warn(`transcript committed, directory durability uncertain: ${error}`); } catch { /* Publication is already committed. */ }
  }
}
/** Copy-on-write publication preserves the exact prior byte prefix. Rename is the logical
 * commit point. Before rename all failures leave the published file unchanged. After rename
 * directory-sync errors are warnings: the process and readers agree on the committed record.
 */
export async function publish(path: string, record: string, io: Storage = disk, committed: () => void = () => {}, signal?: AbortSignal, authorize?: () => void): Promise<void> {
  signal?.throwIfAborted();
  const prior = await io.read(path).catch((error) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  signal?.throwIfAborted();
  const separator = prior.length && prior.at(-1) !== 10 ? "\n" : "";
  const bytes = Buffer.concat([prior, Buffer.from(separator + record + "\n")]);
  const temp = `${path}.${crypto.randomUUID()}.pending`;
  try {
    await stage(temp, bytes, io);
    signal?.throwIfAborted(); // last pre-publication authorization; after rename this is committed
    authorize?.();
    await io.rename(temp, path);
    committed();
  } finally { await io.unlink(temp).catch(() => {}); }
  await syncDirectory(path, io);
}
