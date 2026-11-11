import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RecordFile {
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
  /** Current length in bytes. */
  size(): Promise<number>;
  /** The byte at `position`, undefined past the end. */
  byteAt(position: number): Promise<number | undefined>;
  truncate(length: number): Promise<void>;
}
export interface Storage {
  open(path: string, flags: string): Promise<RecordFile>;
  read(path: string): Promise<Buffer>;
  warn(message: string): void;
}
/** How `publish` opens the transcript: append-only writes, readable for the last byte, created 0600. */
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
      return (await file.read(one, 0, 1, position)).bytesRead ? one[0] : undefined;
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
// The record is already committed here: never report these as an uncommitted append.
function warn(io: Storage, message: string): void {
  try { io.warn(message); } catch { /* Publication is already committed. */ }
}
async function syncDirectory(path: string, io: Storage): Promise<void> {
  try {
    const dir = await io.open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) { warn(io, `transcript committed, directory durability uncertain: ${error}`); }
}
/** Take back whatever an uncommitted append left after `length`. False when the bytes could not be removed. */
async function rollback(file: RecordFile, length: number): Promise<boolean> {
  try { await file.truncate(length); } catch { return false; }
  await file.sync().catch(() => {}); // best effort: the readers already see the old content again
  return true;
}
/** True append: the cost is the record, never the file. The existing bytes are not read (one
 * byte decides the separator), rewritten or moved, and the inode stays.
 *
 * Commit point: the record's bytes are fully written and fsynced, and then the signal and
 * `authorize` (the last pre-commit step, nothing awaited after it) let it stand. Any failure
 * before that truncates the file back to its prior length, so readers see the old content.
 * If that truncation itself fails, what is on disk decides: a complete record line is there
 * for every reader, so it is reported committed (with a warning) rather than leaving disk
 * and process disagreeing; an incomplete line is a torn tail no reader parses, and the next
 * append starts on a fresh line. After the commit, close and directory-sync errors are warnings.
 */
export async function publish(path: string, record: string, io: Storage = disk, committed: () => void = () => {}, signal?: AbortSignal, authorize?: () => void): Promise<void> {
  signal?.throwIfAborted();
  const file = await io.open(path, APPEND);
  let created = false, done = false;
  try {
    const prior = await file.size();
    created = prior === 0; // new or still empty: its directory entry may not be durable yet
    const separator = prior > 0 && await file.byteAt(prior - 1) !== 10 ? "\n" : "";
    signal?.throwIfAborted();
    const bytes = Buffer.from(separator + record + "\n");
    let wrote = false;
    try {
      await writeAll(file, bytes);
      wrote = true;
      await file.sync();
      signal?.throwIfAborted(); // last pre-commit authorization; once it passes this is committed
      authorize?.();
    } catch (error) {
      // A file that cannot report its length is treated as holding the whole record.
      const complete = () => wrote ? true : file.size().then(now => now >= prior + bytes.length - 1, () => true);
      if (await rollback(file, prior) || !await complete()) throw error;
      warn(io, `transcript record could not be withdrawn and stays committed, durability uncertain: ${error}`);
    }
    done = true;
    committed();
  } finally {
    // Before the commit the original failure is the one to report; after it nothing can undo the record.
    await file.close().catch(error => { if (done) warn(io, `transcript committed, close failed: ${error}`); });
  }
  if (created) await syncDirectory(path, io);
}
