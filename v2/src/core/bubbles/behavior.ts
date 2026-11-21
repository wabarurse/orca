// How the user wants agents to act: short lists every agent carries in full, one user-wide and one per bubble.
// An explicit line comes from something the user themself said (the behavior tool checks the source); a list is
// capped, so a full list takes a new line only in place of an old one.
import { join } from "node:path";
import { paths } from "../../config";
import { withStorageLock } from "../lock";
import { bubbleDir, readJson, writeFileAtomic } from "./store";

export type BehaviorLine = { key: string; text: string; confidence: "explicit" | "tentative"; source: string; quote: string; at: string };
export type BehaviorScope = { kind: "user" } | { kind: "bubble"; bubble: string };
export const BEHAVIOR = { lines: 20, text: 200 } as const;

const file = (scope: BehaviorScope): string => scope.kind === "user" ? join(paths.root, "behavior.json") : join(bubbleDir(scope.bubble), "behavior.json");

export async function behavior(scope: BehaviorScope): Promise<BehaviorLine[]> {
  const rows = await readJson<Partial<BehaviorLine>[]>(file(scope), []);
  return rows.filter(row => typeof row.key === "string" && typeof row.text === "string").map(row => ({
    key: row.key ?? "", text: row.text ?? "", confidence: row.confidence === "tentative" ? "tentative" : "explicit",
    source: row.source ?? "", quote: row.quote ?? "", at: row.at ?? "" }));
}

/** Save or replace the line with this key; `text: null` forgets it. */
export async function setBehavior(scope: BehaviorScope, line: BehaviorLine | { key: string; text: null }): Promise<BehaviorLine[]> {
  return withStorageLock(`${file(scope)}.lock`, async () => {
    const rows = (await behavior(scope)).filter(row => row.key !== line.key);
    if (line.text !== null) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (text.length === 0 || text.length > BEHAVIOR.text) throw new Error(`a behavior line must be 1-${BEHAVIOR.text} characters`);
      if (rows.length >= BEHAVIOR.lines) throw new Error(`already ${BEHAVIOR.lines} behavior lines: replace or forget one (keys: ${rows.map(r => r.key).join(", ")})`);
      rows.push({ ...line, text });
    }
    await writeFileAtomic(file(scope), JSON.stringify(rows, null, 2));
    return rows;
  });
}
