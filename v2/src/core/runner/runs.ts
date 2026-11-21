import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { writeAtomic } from "../conversations";
import { pidAlive } from "../lock";
import type { AgentInfo } from "../tools/registry";
import { z } from "zod";
import { parseJson } from "../result";
import type { Role } from "../types";

export type RunState = AgentInfo["state"];
export type RunRecord = AgentInfo & { run: string; conversation: string; handle: string; reported: boolean; error: string | null };

const RunFile = z.object({
  agent: z.string(), role: z.enum(["orchestrator", "worker", "reviewer"]), bundle: z.string(), branch: z.string(),
  state: z.enum(["starting", "running", "reported", "exited", "failed", "stopped"]), pid: z.number().nullable(), runner: z.string(),
  startedAt: z.string(), endedAt: z.string().nullable(), log: z.string(), lastTool: z.string().nullable(),
  run: z.string(), conversation: z.string(), handle: z.string(), reported: z.boolean(), error: z.string().nullable(),
});

const file = (conversation: string, agent: string): string => join(paths.runs(conversation), `${agent}.json`);

export async function readRun(conversation: string, agent: string): Promise<RunRecord | null> {
  const f = Bun.file(file(conversation, agent));
  if (!(await f.exists())) return null;
  let text: string;
  try { text = await f.text(); } catch { return null; }
  const json = parseJson(text);
  const record = json.ok ? RunFile.safeParse(json.data) : null;
  return record !== null && record.success ? record.data : null;
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
  const names = (await readdir(paths.runs(conversation)).catch((): string[] => [])).filter(name => name.endsWith(".json"));
  const runs = await Promise.all(names.map(name => readRun(conversation, name.slice(0, -5))));
  return runs.filter((r): r is RunRecord => r !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export const live = (record: RunRecord): boolean =>
  (record.state === "starting" || record.state === "running" || record.state === "reported") && record.pid !== null && pidAlive(record.pid);

export function newRun(input: { conversation: string; agent: string; role: Role; bundle: string; branch: string; runner: string }): RunRecord {
  return { ...input, run: crypto.randomUUID(), state: "starting", pid: null, handle: "", startedAt: new Date().toISOString(), endedAt: null,
    log: join(paths.logs(input.conversation), `${input.agent}.log`), lastTool: null, reported: false, error: null };
}
