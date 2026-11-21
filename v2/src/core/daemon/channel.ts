// The files between the daemon and its clients (TUIs, `orca2 msg`), under conversations/<id>/daemon/:
// status.json (what the daemon is doing), commands/ (requests, oldest first, each read once) and live.jsonl.
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { writeAtomic } from "../conversations";
import { lockOwner, pidAlive } from "../lock";

export type DaemonStatus = { pid: number; run: string; state: "idle" | "turn" | "stopped"; since: string; turns: number; error: string | null; contextTokens: number | null };
export type Command = { id: string; kind: "cancel" | "compact" | "stop"; at: string };

const dir = (conversation: string): string => paths.daemon(conversation);
export const lockPath = (conversation: string): string => join(dir(conversation), "lock");

export async function writeStatus(conversation: string, status: DaemonStatus): Promise<void> {
  await mkdir(dir(conversation), { recursive: true, mode: 0o700 });
  await writeAtomic(join(dir(conversation), "status.json"), JSON.stringify(status));
}

export async function readStatus(conversation: string): Promise<DaemonStatus | null> {
  const file = Bun.file(join(dir(conversation), "status.json"));
  if (!(await file.exists())) return null;
  try { return await file.json() as DaemonStatus; } catch { return null; }
}

/** The pid holding the daemon lock, when that process is alive. */
export async function daemonPid(conversation: string): Promise<number | null> {
  const owner = await lockOwner(lockPath(conversation));
  return owner !== undefined && pidAlive(owner.pid) ? owner.pid : null;
}

let sequence = 0;
export async function request(conversation: string, kind: Command["kind"]): Promise<Command> {
  const commands = join(dir(conversation), "commands");
  await mkdir(commands, { recursive: true, mode: 0o700 });
  const command: Command = { id: crypto.randomUUID(), kind, at: new Date().toISOString() };
  await writeAtomic(join(commands, `${Date.now().toString().padStart(15, "0")}-${process.pid}-${sequence++}.json`), JSON.stringify(command));
  return command;
}

export async function takeCommands(conversation: string): Promise<Command[]> {
  const commands = join(dir(conversation), "commands");
  const names = (await readdir(commands).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort();
  const out: Command[] = [];
  for (const name of names) {
    const file = join(commands, name);
    try { out.push(await Bun.file(file).json() as Command); } catch { /* half-written by an older client */ }
    await rm(file, { force: true });
  }
  return out;
}
