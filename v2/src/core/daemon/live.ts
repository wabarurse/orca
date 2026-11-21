import { appendFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { z } from "zod";
import { MessageRecord } from "../inbox";
import { parseJson } from "../result";
import type { AgentEvent } from "../types";

const Call = z.object({ id: z.string(), name: z.string(), input: z.unknown() });
const Status = z.enum(["done", "cancelled", "failed"]);
const EventRecord: z.ZodType<AgentEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), agent: z.string(), role: z.enum(["orchestrator", "worker", "reviewer"]), model: z.string() }),
  z.object({ kind: z.literal("input"), messages: z.array(MessageRecord) }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tool_start"), call: Call }),
  z.object({ kind: z.literal("tool_end"), call: Call, outcome: z.object({ id: z.string(), ok: z.boolean(), text: z.string() }) }),
  z.object({ kind: z.literal("notice"), text: z.string() }),
  z.object({ kind: z.literal("usage"), model: z.string(), input: z.number(), cached: z.number(), output: z.number() }),
  z.object({ kind: z.literal("compaction"), before: z.number(), after: z.number() }),
  z.object({ kind: z.literal("end"), status: Status, error: z.string().nullable(), text: z.string() }),
]);
const LineRecord = z.object({ seq: z.number(), turn: z.number(), event: EventRecord.nullable() });

export type LiveLine = { seq: number; turn: number; event: AgentEvent | null };
const file = (conversation: string): string => join(paths.daemon(conversation), "live.jsonl");

export function liveWriter(conversation: string, turn: number): { emit: (event: AgentEvent) => void; end: () => Promise<void> } {
  let seq = 0;
  let chain: Promise<void> = (async () => {
    await mkdir(paths.daemon(conversation), { recursive: true, mode: 0o700 });
    await Bun.write(file(conversation), JSON.stringify({ seq: seq++, turn, event: null } satisfies LiveLine) + "\n");
  })().catch(() => {});
  return {
    emit(event) {
      const line = JSON.stringify({ seq: seq++, turn, event } satisfies LiveLine) + "\n";
      chain = chain.then(() => appendFile(file(conversation), line)).catch(() => {});
    },
    async end() {
      await chain;
      await rm(file(conversation), { force: true });
    },
  };
}

export async function readLive(conversation: string, turn: number, offset: number): Promise<{ events: AgentEvent[]; offset: number }> {
  let handle;
  try { handle = await open(file(conversation), "r"); } catch { return { events: [], offset: 0 }; }
  try {
    const size = (await handle.stat()).size;
    if (size < offset) offset = 0;
    const bytes = Buffer.alloc(size - offset);
    await handle.read(bytes, 0, bytes.length, offset);
    const end = bytes.lastIndexOf(10) + 1;
    const events: AgentEvent[] = [];
    for (const raw of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (raw.length === 0) continue;
      const json = parseJson(raw);
      const line = json.ok ? LineRecord.safeParse(json.data) : null;
      if (line === null || !line.success) continue;
      if (line.data.turn !== turn) return { events: [], offset: 0 };
      if (line.data.event !== null) events.push(line.data.event);
    }
    return { events, offset: offset + end };
  } finally { await handle.close(); }
}
