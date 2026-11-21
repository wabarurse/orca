// The turn's live events (streamed text, tool starts and ends, notices) in daemon/live.jsonl, so every TUI can show
// a turn as it happens. Replaced at each turn's start; the transcript stays the durable record.
import { appendFile, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import type { AgentEvent } from "../types";

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

/** Complete lines appended since `offset` for `turn`, and the next offset; a file for another turn reads as empty. */
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
      try {
        const line = JSON.parse(raw) as LiveLine;
        if (line.turn !== turn) return { events: [], offset: 0 };
        if (line.event !== null) events.push(line.event);
      } catch { /* torn line */ }
    }
    return { events, offset: offset + end };
  } finally { await handle.close(); }
}
