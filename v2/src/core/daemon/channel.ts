import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseJson, paths } from "../../config";
import { writeAtomic } from "../conversations";
import { z } from "zod";
import { lockOwner, pidAlive } from "../lock";
import { OpenSpanRecord } from "../spans";
import type { OpenSpan } from "../types";

export type DaemonStatus = { pid: number; run: string; build: string; state: "idle" | "turn" | "stopped"; since: string; turns: number; error: string | null; contextTokens: number | null; phase: OpenSpan | null };
export type Command = { id: string; kind: "cancel" | "compact" | "stop"; at: string };
const StatusRecord = z.object({ pid: z.number(), run: z.string(), build: z.string().default("unknown"), state: z.enum(["idle", "turn", "stopped"]), since: z.string(), turns: z.number(),
  error: z.string().nullable(), contextTokens: z.number().nullable(), phase: OpenSpanRecord.nullable().default(null) });
const CommandRecord = z.object({ id: z.string(), kind: z.enum(["cancel", "compact", "stop"]), at: z.string() });

async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try { text = await Bun.file(path).text(); } catch { return null; }
  const json = parseJson(text);
  if (!json.ok) return null;
  const parsed = schema.safeParse(json.data);
  return parsed.success ? parsed.data : null;
}

const dir = (conversation: string): string => paths.daemon(conversation);
export const lockPath = (conversation: string): string => join(dir(conversation), "lock");

export async function writeStatus(conversation: string, status: DaemonStatus): Promise<void> {
  await mkdir(dir(conversation), { recursive: true, mode: 0o700 });
  await writeAtomic(join(dir(conversation), "status.json"), JSON.stringify(status));
}

export async function readStatus(conversation: string): Promise<DaemonStatus | null> {
  const path = join(dir(conversation), "status.json");
  if (!(await Bun.file(path).exists())) return null;
  return readRecord(path, StatusRecord);
}

export async function daemonPid(conversation: string): Promise<number | null> {
  const owner = await lockOwner(lockPath(conversation));
  return owner !== null && pidAlive(owner.pid) ? owner.pid : null;
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
  const names = (await readdir(commands).catch((): string[] => [])).filter(name => name.endsWith(".json")).sort();
  const out: Command[] = [];
  for (const name of names) {
    const file = join(commands, name);
    const command = await readRecord(file, CommandRecord);
    if (command !== null) out.push(command);
    await rm(file, { force: true });
  }
  return out;
}
