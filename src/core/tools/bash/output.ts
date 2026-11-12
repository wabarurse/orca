import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { conversationIds, paths } from "../../../config";
import { workspaces } from "../../data/projects";

const RETENTION_MS = 7 * 86400_000;
// Stays at the largest `maxToolOutputBytes` config.ts admits (256 MiB), so one allowed output always fits.
const STORED_BYTES = 256 * 1024 * 1024;
const filename = /^[0-9a-f-]{36}\.(txt|partial|running)$/;
export interface PrunedOutput { path: string; bytes?: number; disposition: string }
interface Found { name: string; path: string; bytes: number; time: number; directory: string }

/** Every regular file under `dir`, links never followed. A file that vanishes meanwhile is skipped. */
async function outputFiles(dir: string, skip: (path: string, name: string) => boolean, found: Found[] = [], top = true): Promise<Found[]> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (top && skip(path, name)) continue;
    try {
      const s = await lstat(path);
      if (s.isDirectory()) await outputFiles(path, skip, found, false);
      else if (s.isFile()) found.push({ name, path, bytes: s.size, time: s.mtimeMs, directory: dir });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return found;
}

/** Unowned outputs this module named (`<uuid>.txt|partial|running`) are bounded by
 * age/space, at any depth. Any other file is never removed here: evidence an agent saved
 * (recordings, reports) may not be registered yet, or ever, in a project whose workspace
 * discovery has not run, and only workspace archival may decide to delete it. Registered
 * outputs (a top-level entry owned as an "artifact", with everything under it) follow
 * workspace archive/explicit-clean retention, `verification/` its sandbox's; live
 * `.running` files are excluded until stale. `apply` false lists without deleting. */
export async function pruneOutputs(dir: string, now = Date.now(), byteLimit = STORED_BYTES, project?: string, apply = true): Promise<PrunedOutput[]> {
  const kept = (path: string, name: string) => name === "verification" || !!(project && workspaces.resource(project, "artifact", path));
  const files = (await outputFiles(dir, kept)).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  const pruned: PrunedOutput[] = [], emptied = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (!filename.test(f.name)) continue;
    const old = now - f.time > RETENTION_MS;
    if (f.name.endsWith(".running") && !old) continue;
    total += f.bytes;
    if (!old && total <= byteLimit) continue;
    const why = old ? "older than 7 days" : "over the stored-output limit";
    if (apply) { await unlink(f.path).catch(e => { if (e.code !== "ENOENT") throw e; }); if (f.directory !== dir) emptied.add(f.directory); }
    pruned.push({ path: f.path, bytes: f.bytes, disposition: apply ? `removed tool output ${why}` : `eligible: tool output ${why}` });
  }
  // Emptied folders go, then the parents that emptied; one that still holds anything refuses and stays.
  for (let directory of emptied) while (directory !== dir && await rmdir(directory).then(() => true, () => false)) directory = dirname(directory);
  return pruned;
}

/** One project's saved outputs; a project without any has nothing to list. */
export async function pruneProjectOutputs(project: string, apply: boolean, now = Date.now()): Promise<PrunedOutput[]> {
  const dir = join(paths.project(project), "tool-outputs");
  try { return await pruneOutputs(dir, now, STORED_BYTES, project, apply); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}

/** Every project, idle ones included (an idle project never runs the command that prunes
 * its own). Best effort: a project that cannot be inspected is one "kept" row, never an error. */
export async function pruneAllOutputs(apply: boolean, now = Date.now()): Promise<PrunedOutput[]> {
  const pruned: PrunedOutput[] = [];
  let projects: string[];
  try { projects = conversationIds(paths.root); }
  catch (error) { return [{ path: paths.root, disposition: `kept: tool outputs not inspected (${error})` }]; }
  for (const project of projects) {
    try { pruned.push(...await pruneProjectOutputs(project, apply, now)); }
    catch (error) { pruned.push({ path: project, disposition: `kept: tool outputs not inspected (${error})` }); }
  }
  return pruned;
}

/** Exclusive private file outside the repository, with a distinct incomplete state. */
export async function outputArtifact(project: string) {
  const dir = join(paths.project(project), "tool-outputs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Storage failure must be reported before starting a command with side effects.
  await pruneOutputs(dir, Date.now(), STORED_BYTES, project);
  const stem = join(dir, crypto.randomUUID());
  const running = `${stem}.running`;
  const file = await open(running, "wx", 0o600);
  return {
    partialPath: `${stem}.partial`,
    async write(bytes: Uint8Array) {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error("could not save tool output");
        offset += bytesWritten;
      }
    },
    async finish(complete: boolean) {
      await file.close();
      const path = `${stem}.${complete ? "txt" : "partial"}`;
      await rename(running, path);
      workspaces.own(project, "artifact", path, { path });
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
    if (Buffer.byteLength(footer) + 80 > max) throw new Error("tool output metadata exceeds preview budget; increase maxToolResultBytes");
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
