// How the user wants the agents of a bubble to act: a short list every member carries in full. A line is written
// only from something the user themself said (the caller verifies the source); it is capped, so a full list takes
// a new line only in place of an old one.
import { join } from "node:path";
import { withStorageLock } from "../storage-lock";
import { bubbleDir, readJson, writeFileAtomic } from "./store";

/** `source` is the id of the human message the line comes from, `quote` a short excerpt of it. */
export interface BehaviorLine { key: string; text: string; source: string; quote: string; at: string }
export const BEHAVIOR = { lines: 20, text: 200 } as const;
const file = (bubble: string) => join(bubbleDir(bubble), "behavior.json");

export async function behavior(bubble: string): Promise<BehaviorLine[]> {
  return readJson<BehaviorLine[]>(file(bubble), []);
}
/** Save or replace the line with this key; `text: null` forgets it. */
export async function setBehavior(bubble: string, line: BehaviorLine | { key: string; text: null }): Promise<BehaviorLine[]> {
  return withStorageLock(join(bubbleDir(bubble), ".behavior-lock"), async () => {
    const rows = (await behavior(bubble)).filter(row => row.key !== line.key);
    if (line.text !== null) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text || text.length > BEHAVIOR.text) throw new Error(`a behavior line must be 1-${BEHAVIOR.text} characters`);
      if (rows.length >= BEHAVIOR.lines) throw new Error(`the bubble already has ${BEHAVIOR.lines} behavior lines: replace or forget one (keys: ${rows.map(r => r.key).join(", ")})`);
      rows.push({ ...line, text });
    }
    await writeFileAtomic(file(bubble), JSON.stringify(rows));
    return rows;
  });
}
