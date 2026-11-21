// Run records: runs/<agent>.json says what each agent of a conversation is doing, for `subagent list`, the Agents
// tab and the exit watchdog. Written by the agent process itself (and by whoever starts or stops it).
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { writeAtomic } from "../conversations";
import { pidAlive } from "../lock";
import type { AgentInfo } from "../tools/registry";
import type { Role } from "../types";

export type RunState = AgentInfo["state"];
export type RunRecord = AgentInfo & { run: string; conversation: string; handle: string; reported: boolean; error: string | null };

const file = (conversation: string, agent: string): string => join(paths.runs(conversation), `${agent}.json`);

export async function readRun(conversation: string, agent: string): Promise<RunRecord | null> {
  const f = Bun.file(file(conversation, agent));
  if (!(await f.exists())) return null;
  try { return await f.json() as RunRecord; } catch { return null; }
}

export async function writeRun(record: RunRecord): Promise<void> {
  await mkdir(paths.runs(record.conversation), { recursive: true, mode: 0o700 });
  await writeAtomic(file(record.conversation, record.agent), JSON.stringify(record, null, 2));
}

export async function updateRun(conversation: string, agent: string, patch: Partial<RunRecord>): Promise<RunRecord | null> {
  const current = await readRun(conversation, agent);
  if (current === null) return null;
  const next = { ...current, ...patch };
  await writeRun(next);
  return next;
}

export async function listRuns(conversation: string): Promise<RunRecord[]> {
  const names = (await readdir(paths.runs(conversation)).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
  const runs = await Promise.all(names.map(name => readRun(conversation, name.slice(0, -5))));
  return runs.filter((r): r is RunRecord => r !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export const live = (record: RunRecord): boolean =>
  (record.state === "starting" || record.state === "running" || record.state === "reported") && record.pid !== null && pidAlive(record.pid);

export function newRun(input: { conversation: string; agent: string; role: Role; bundle: string; branch: string; runner: string }): RunRecord {
  return { ...input, run: crypto.randomUUID(), state: "starting", pid: null, handle: "", startedAt: new Date().toISOString(), endedAt: null,
    log: join(paths.logs(input.conversation), `${input.agent}.log`), lastTool: null, reported: false, error: null };
}
