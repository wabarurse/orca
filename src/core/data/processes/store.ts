import { usageEvent } from "../../../providers";
import { assertProjectIdentity } from "../projects";
import { mkdir, readdir, rename, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import type { Role, Message } from "../../../protocol";
import { pidAlive, withStorageLock } from "../storage-lock";
import { put } from "../inbox";

export interface ProcessRecord {
  incarnation?: string;
  id: string; project: string; owner: string; role: Role; branch?: string; run?: string; call?: string;
  cwd: string; command: string; createdAt: string; updatedAt: string;
  state: "starting" | "running" | "exited" | "failed" | "cancelled" | "timed_out" | "unknown";
  supervisorPid?: number; pid?: number; exitCode?: number; reason?: string; readyUrl?: string; readyAt?: string;
  timeoutMs: number; maxBytes: number; notify: boolean;
  events: { event: NonNullable<Message["event"]>; text: string; delivered?: boolean }[];
}
export const liveProcess = (p: ProcessRecord) => p.state === "starting" || p.state === "running";
const indexed = new Map<string, Set<string>>();
export function processDirectory(project: string, id?: string): string {
  if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid process handle");
  return join(paths.runtimeProject(project), "processes", ...(id ? [id] : []));
}
export async function saveProcess(p: ProcessRecord): Promise<void> {
  if (p.incarnation) assertProjectIdentity(p.project, p.incarnation, "saving process state");
  const dir = processDirectory(p.project, p.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withStorageLock(join(dir, "record.lock"), async () => {
    const active = join(processDirectory(p.project), "active");
    await mkdir(active, { recursive: true, mode: 0o700 });
    // Publish recovery intent first. A crash can leave extra recovery work, never
    // an untracked running command or an undelivered durable event.
    await writeFile(join(active, p.id), "\n", { mode: 0o600 });
    const temp = join(dir, `.state-${crypto.randomUUID()}`);
    await writeFile(temp, JSON.stringify(p) + "\n", { mode: 0o600 });
    await rename(temp, join(dir, "state.json"));
    if (!liveProcess(p) && (!p.notify || p.events.every(e => e.delivered))) await unlink(join(active, p.id)).catch(() => {});
  });
}
/** Seed the recovery index once for existing homes; terminal history stays inspectable. */
export async function recoverableProcesses(project: string): Promise<ProcessRecord[]> {
  const dir = join(processDirectory(project), "active"), marker = join(dir, ".initialized");
  if (!indexed.has(dir) || !await Bun.file(marker).exists()) await withStorageLock(join(processDirectory(project), "index.lock"), async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const records = await listProcesses(project);
    for (const p of records) if (liveProcess(p) || (p.notify && p.events.some(e => !e.delivered))) await writeFile(join(dir, p.id), "\n", { mode: 0o600 });
    indexed.set(dir, new Set(records.map(p => p.id)));
    await writeFile(marker, "1\n", { mode: 0o600 });
  });
  // Directory names are cheap to inspect. Discover older, still-running builds
  // that create commands without publishing an active marker after an update.
  for (const id of await readdir(processDirectory(project))) {
    if (!/^[a-f0-9-]{36}$/.test(id) || indexed.get(dir)!.has(id)) continue;
    try {
      const p = await readProcess(project, id);
      if (liveProcess(p) || (p.notify && p.events.some(e => !e.delivered))) await writeFile(join(dir, id), "\n", { mode: 0o600 });
      indexed.get(dir)!.add(id);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const result: ProcessRecord[] = [];
  for (const id of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    try { result.push(await readProcess(project, id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
export async function readProcess(project: string, id: string): Promise<ProcessRecord> {
  const p = await Bun.file(join(processDirectory(project, id), "state.json")).json() as ProcessRecord;
  if (p.id !== id || p.project !== project) throw new Error("process identity mismatch");
  return p;
}
export async function listProcesses(project: string): Promise<ProcessRecord[]> {
  const ids = await readdir(processDirectory(project)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const result: ProcessRecord[] = [];
  for (const id of ids.filter(id => /^[a-f0-9-]{36}$/.test(id))) result.push(await readProcess(project, id));
  return result;
}
export async function processOutput(project: string, id: string, cursor = 0, bytes = 12000) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32000) throw new Error("invalid output cursor/limit");
  const path = join(processDirectory(project, id), "output.txt");
  const file = await open(path, "r").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!file) return { content: "", cursor, path };
  try {
    const data = Buffer.alloc(bytes), { bytesRead } = await file.read(data, 0, bytes, cursor);
    return { content: data.subarray(0, bytesRead).toString("utf8"), cursor: cursor + bytesRead, path };
  } finally { await file.close(); }
}
export async function addProcessEvent(p: ProcessRecord, state: string): Promise<void> {
  const at = new Date().toISOString();
  p.updatedAt = at;
  p.events.push({ event: { id: crypto.randomUUID(), processId: p.id, sequence: p.events.length + 1, state, at },
    text: JSON.stringify({ process: p.id, state, exitCode: p.exitCode, reason: p.reason, readyUrl: p.readyUrl,
      output: join(processDirectory(p.project, p.id), "output.txt"), owner: p.owner }) });
  if (["exited", "failed", "cancelled", "timed_out"].includes(state)) await usageEvent({ kind: "process", project: p.project,
    agent: p.owner, run: p.run, process: p.id, state, durationMs: Math.max(0, Date.parse(at) - Date.parse(p.createdAt)) });
  await saveProcess(p); // The outbox is durable before any inbox publication.
  await deliverProcessEvents(p);
}
export async function deliverProcessEvents(p: ProcessRecord): Promise<void> {
  if (!p.notify) return;
  if (p.incarnation) assertProjectIdentity(p.project, p.incarnation, "delivering process event");
  for (const e of p.events) if (!e.delivered) {
    await put(p.project, p.owner, { from: "runtime", text: e.text, event: e.event });
    e.delivered = true;
    await saveProcess(p);
  }
}
export async function reconcileProcesses(project: string): Promise<void> {
  for (const snapshot of await recoverableProcesses(project)) {
    if (snapshot.supervisorPid && pidAlive(snapshot.supervisorPid)) continue;
    if (!snapshot.supervisorPid && Date.now() - Date.parse(snapshot.createdAt) < 10000) continue;
    await withStorageLock(join(processDirectory(project, snapshot.id), "recovery.lock"), async () => {
      const p = await readProcess(project, snapshot.id);
      if (p.supervisorPid && pidAlive(p.supervisorPid)) return;
      if (liveProcess(p)) {
        p.state = "unknown"; p.reason = "supervisor disappeared; command may have had effects and will not be replayed";
        await addProcessEvent(p, "unknown");
      } else await deliverProcessEvents(p);
      if (!liveProcess(p) && (!p.notify || p.events.every(e => e.delivered))) await unlink(join(processDirectory(project), "active", p.id)).catch(() => {});
    });
  }
}
