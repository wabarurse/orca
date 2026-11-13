import { usageEvent } from "../../../api";
import { assertProjectIdentity, workspaces } from "../projects";
import { mkdir, readdir, rename, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import type { Role, Message } from "../../../protocol";
import { pidAlive, withStorageLock } from "../storage-lock";
import { put, transferProcessEvents } from "../inbox";
import { processInspection } from "./inspection";
import { execution } from "../projects/lifecycle";
import { reconcileVerifications } from "./verification";

export interface ProcessCustody { owner: string; from: string; id: string; at: string; reason: string; pending: boolean }
export interface ProcessRecord {
  /** Execution outcome and resource liveness are independent. Unknown never means success. */
  settledAt?: string;
  /** Shared daemon observation, with no shell or command slot. */
  prWatch?: boolean;
  watchEpoch?: string;
  /** Read from custody.json; supervisor snapshots never overwrite routing. */
  custody?: ProcessCustody;
  workspaceSession?: string;
  incarnation?: string;
  id: string; project: string; owner: string; role: Role; branch?: string; run?: string; call?: string;
  verification?: string;
  recording?: boolean;
  artifact?: string;
  prChecks?: { repository: string; number: number; head: string };
  cwd: string; command: string; createdAt: string; updatedAt: string;
  state: "starting" | "running" | "exited" | "failed" | "cancelled" | "timed_out" | "unknown";
  supervisorPid?: number; pid?: number; exitCode?: number; reason?: string; readyUrl?: string; readyAt?: string;
  timeoutMs: number; maxBytes: number; notify: boolean;
  events: { event: NonNullable<Message["event"]>; text: string; delivered?: boolean }[];
}
export const liveProcess = (p: ProcessRecord) => p.state === "starting" || p.state === "running";
export const processOwner = (p: ProcessRecord) => p.custody?.owner ?? p.owner;
export const unresolvedProcess = (p: ProcessRecord) => liveProcess(p) || (p.state === "unknown" && !p.settledAt);
const needsRecovery = (p: ProcessRecord) => unresolvedProcess(p) || p.custody?.pending || (p.notify && p.events.some(e => !e.delivered));
const indexed = new Map<string, Set<string>>();
const watched = new Map<string, Set<string>>();
export function processDirectory(project: string, id?: string): string {
  if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid process handle");
  return join(paths.runtimeProject(project), "processes", ...(id ? [id] : []));
}
export async function saveProcess(p: ProcessRecord, deliveryOnly = false): Promise<void> {
  if (p.incarnation) assertProjectIdentity(p.project, p.incarnation, "saving process state");
  const dir = processDirectory(p.project, p.id);
  if (p.workspaceSession) {
    workspaces.touch(p.workspaceSession, p.updatedAt);
    workspaces.own(p.project, "process", p.id, { session: workspaces.get(p.workspaceSession), path: dir });
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withStorageLock(join(dir, "record.lock"), async () => {
    const prior = await Bun.file(join(dir, "state.json")).json().catch(error => { if (error.code === "ENOENT") return undefined; throw error; }) as ProcessRecord | undefined;
    // A supervisor retains a local snapshot. Never regress an acknowledged
    // delivery when a ready/completion update races recovery or a handoff.
    const events = new Map(prior?.events.map(e => [e.event.id, e]));
    for (const e of p.events) events.set(e.event.id, { ...e, delivered: e.delivered || events.get(e.event.id)?.delivered });
    p.events = [...events.values()];
    if (deliveryOnly && prior) Object.assign(p, { ...prior, events: p.events });
    if (prior?.prWatch && !liveProcess(prior) && liveProcess(p)) { p.state = prior.state; p.reason = prior.reason; }
    p.custody = await readCustody(p.project, p.id);
    const active = join(processDirectory(p.project), "active");
    await mkdir(active, { recursive: true, mode: 0o700 });
    // Publish recovery intent first. A crash can leave extra recovery work, never
    // an untracked running command or an undelivered durable event.
    await writeFile(join(active, p.id), "\n", { mode: 0o600 });
    const temp = join(dir, `.state-${crypto.randomUUID()}`);
    const { custody: _, ...record } = p;
    await writeFile(temp, JSON.stringify(record) + "\n", { mode: 0o600 });
    await rename(temp, join(dir, "state.json"));
    if (!needsRecovery(p)) {
      await unlink(join(active, p.id)).catch(() => {});
      watched.get(active)?.delete(p.id);
    }
  });
}
/** Seed the recovery index once for existing homes; terminal history stays inspectable. */
export async function recoverableProcesses(project: string): Promise<ProcessRecord[]> {
  const dir = join(processDirectory(project), "active"), marker = join(dir, ".initialized");
  if (!indexed.has(dir) || (await Bun.file(marker).text().catch(() => "")) !== "2\n") await withStorageLock(join(processDirectory(project), "index.lock"), async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const records = await listProcesses(project);
    for (const p of records) if (needsRecovery(p)) await writeFile(join(dir, p.id), "\n", { mode: 0o600 });
    indexed.set(dir, new Set(records.map(p => p.id)));
    watched.set(dir, new Set(records.filter(needsRecovery).map(p => p.id)));
    await writeFile(marker, "2\n", { mode: 0o600 });
  });
  // Directory names are cheap to inspect. Discover older, still-running builds
  // that create commands without publishing an active marker after an update.
  for (const id of await readdir(processDirectory(project))) {
    if (!/^[a-f0-9-]{36}$/.test(id) || indexed.get(dir)!.has(id)) continue;
    try {
      const p = await readProcess(project, id);
      if (needsRecovery(p)) await writeFile(join(dir, id), "\n", { mode: 0o600 });
      indexed.get(dir)!.add(id);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const result: ProcessRecord[] = [];
  const handoffs = await readdir(join(processDirectory(project), "handoffs")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  // Older supervisors may remove their marker when publishing an unknown
  // outcome. Keep watching records seen live until they really settle.
  const tracking = watched.get(dir)!;
  for (const id of new Set([...await readdir(dir), ...handoffs, ...tracking])) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    try {
      const p = await readProcess(project, id);
      if (needsRecovery(p)) tracking.add(id); else tracking.delete(id);
      result.push(p);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      tracking.delete(id);
      await unlink(join(dir, id)).catch(() => {});
      await unlink(join(processDirectory(project), "handoffs", id)).catch(() => {});
    }
  }
  return result;
}
export async function readProcess(project: string, id: string): Promise<ProcessRecord> {
  const p = await Bun.file(join(processDirectory(project, id), "state.json")).json() as ProcessRecord;
  if (p.id !== id || p.project !== project) throw new Error("process identity mismatch");
  p.custody = await readCustody(project, id);
  return p;
}
export async function readCustody(project: string, id: string): Promise<ProcessCustody | undefined> {
  const c = await Bun.file(join(processDirectory(project, id), "custody.json")).json().catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  const agent = /^(orchestrator|(?:worker|reviewer)(?:-[A-Za-z0-9._-]+)?)$/;
  if (c !== undefined && (!c || !agent.test(c.owner) || !agent.test(c.from) || !/^[a-f0-9-]{36}$/.test(c.id) ||
    !Number.isFinite(Date.parse(c.at)) || typeof c.reason !== "string" || typeof c.pending !== "boolean")) throw new Error("invalid process handoff record");
  return c;
}
export async function saveCustody(project: string, id: string, custody: ProcessCustody): Promise<void> {
  const file = join(processDirectory(project, id), "custody.json"), temp = `${file}.${crypto.randomUUID()}`;
  await writeFile(temp, JSON.stringify(custody), { mode: 0o600 }); await rename(temp, file);
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
  const terminal = !liveProcess(p);
  // A short tail often contains the test summary or exact-head check result.
  // Keep the complete stream in its existing artifact.
  const path = join(processDirectory(p.project, p.id), "output.txt");
  const size = terminal ? Bun.file(path).size : 0;
  const tail = size > 0 ? await processOutput(p.project, p.id, Math.max(0, size - 1500), 1500)
    .then(out => out.content, () => undefined) : undefined;
  p.events.push({ event: { id: crypto.randomUUID(), processId: p.id, sequence: p.events.length + 1, state, at },
    text: JSON.stringify({ process: p.id, state, exitCode: p.exitCode, reason: p.reason, readyUrl: p.readyUrl,
      output: path, owner: p.owner, prChecks: p.prChecks, artifact: p.artifact, tail }) });
  if (["exited", "failed", "cancelled", "timed_out"].includes(state)) await usageEvent({ kind: "process", project: p.project,
    agent: p.owner, run: p.run, process: p.id, state, durationMs: Math.max(0, Date.parse(at) - Date.parse(p.createdAt)) });
  await saveProcess(p); // The outbox is durable before any inbox publication.
  await deliverProcessEvents(p);
}
export async function deliverProcessEvents(snapshot: ProcessRecord): Promise<void> {
  await withStorageLock(join(processDirectory(snapshot.project, snapshot.id), "routing.lock"), async () => {
    const p = await readProcess(snapshot.project, snapshot.id);
    if (p.incarnation) assertProjectIdentity(p.project, p.incarnation, "delivering process event");
    // Supervisors loaded before handoff support may still publish to their
    // original inbox. Forward unread events until that supervisor has exited.
    if (p.custody) for (const from of new Set([p.owner, p.custody.from])) {
      await transferProcessEvents(p.project, from, p.custody.owner, p.id);
    }
    if (p.custody?.pending) {
      const c = p.custody;
      await put(p.project, c.owner, { from: "runtime", text: JSON.stringify({ process: p.id, state: p.state,
        handoff: { from: c.from, to: c.owner, reason: c.reason }, output: join(processDirectory(p.project, p.id), "output.txt"),
        instruction: "Ownership transferred; inspect existing results. This does not authorize restarting the command." }),
        event: { id: c.id, processId: p.id, sequence: 0, state: "handoff", at: c.at } });
      c.pending = false; await saveCustody(p.project, p.id, c);
    }
    if (p.notify) for (const e of p.events) if (!e.delivered) {
      await put(p.project, processOwner(p), { from: "runtime", text: e.text, event: e.event });
      e.delivered = true;
      await saveProcess(p, true);
    }
    if (!needsRecovery(p)) {
      const active = join(processDirectory(p.project), "active");
      await unlink(join(active, p.id)).catch(() => {});
      watched.get(active)?.delete(p.id);
    }
    if (p.custody && !needsRecovery(p) && (!p.supervisorPid || !pidAlive(p.supervisorPid))) {
      await unlink(join(processDirectory(p.project), "handoffs", p.id)).catch(() => {});
    }
  });
}
export async function reconcileProcesses(project: string): Promise<void> {
  await reconcileVerifications(project);
  const inspect = processInspection();
  for (const snapshot of await recoverableProcesses(project)) {
    if (snapshot.custody) await deliverProcessEvents(snapshot);
    if (snapshot.prWatch) {
      if (liveProcess(snapshot) && execution.stale(project, snapshot.watchEpoch ?? "")) {
        snapshot.state = "cancelled"; snapshot.reason = "PR watch stopped with its conversation";
        await saveProcess(snapshot);
      }
      continue;
    }
    if (!unresolvedProcess(snapshot)) { await deliverProcessEvents(snapshot); continue; }
    if (liveProcess(snapshot) && snapshot.supervisorPid && pidAlive(snapshot.supervisorPid)) continue;
    if (!snapshot.supervisorPid && Date.now() - Date.parse(snapshot.createdAt) < 10000) continue;
    // Unknown records remain in recovery until OS evidence proves all resources
    // gone. This also recovers old builds' unknown records after index upgrade.
    const blocker = inspect(snapshot);
    if (blocker && liveProcess(snapshot) && (!snapshot.supervisorPid || pidAlive(snapshot.supervisorPid))) continue;
    if (blocker && !liveProcess(snapshot)) { await deliverProcessEvents(snapshot); continue; }
    await withStorageLock(join(processDirectory(project, snapshot.id), "recovery.lock"), async () => {
      const p = await readProcess(project, snapshot.id);
      if (p.pid !== snapshot.pid || p.supervisorPid !== snapshot.supervisorPid || p.updatedAt !== snapshot.updatedAt) return;
      if (liveProcess(p)) {
        p.state = "unknown"; p.reason = "supervisor disappeared; command may have had effects and will not be replayed";
        if (!blocker) p.settledAt = new Date().toISOString();
        await addProcessEvent(p, "unknown");
      } else {
        if (p.state === "unknown" && !p.settledAt) { p.settledAt = new Date().toISOString(); await saveProcess(p); }
        await deliverProcessEvents(p);
      }
    });
  }
}
