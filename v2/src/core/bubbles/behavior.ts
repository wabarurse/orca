import { join } from "node:path";
import { fail, ok, paths, type Result } from "../../config";
import { z } from "zod";
import { withStorageLock } from "../lock";
import { bubbleDir, readJson, rows as validRows, writeFileAtomic } from "./store";

export type BehaviorLine = { key: string; text: string; confidence: "explicit" | "tentative"; source: string; quote: string; at: string };
export type BehaviorScope = { kind: "user" } | { kind: "bubble"; bubble: string };
export const BEHAVIOR = { lines: 20, text: 200 } as const;

const file = (scope: BehaviorScope): string => scope.kind === "user" ? join(paths.root, "behavior.json") : join(bubbleDir(scope.bubble), "behavior.json");

const Row = z.object({ key: z.string(), text: z.string(), confidence: z.unknown(), source: z.string().optional(), quote: z.string().optional(), at: z.string().optional() });

async function lines(scope: BehaviorScope): Promise<Result<BehaviorLine[]>> {
  const json = await readJson(file(scope));
  if (!json.ok) return json;
  return ok(validRows(json.data, Row).map(row => ({
    key: row.key, text: row.text, confidence: row.confidence === "tentative" ? "tentative" : "explicit",
    source: row.source ?? "", quote: row.quote ?? "", at: row.at ?? "" })));
}

export async function behavior(scope: BehaviorScope): Promise<BehaviorLine[]> {
  const found = await lines(scope);
  return found.ok ? found.data : [];
}

export async function setBehavior(scope: BehaviorScope, line: BehaviorLine | { key: string; text: null }): Promise<Result<BehaviorLine[]>> {
  return withStorageLock(`${file(scope)}.lock`, async () => {
    const current = await lines(scope);
    if (!current.ok) return current;
    const rows = current.data.filter(row => row.key !== line.key);
    if (line.text !== null) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (text.length === 0 || text.length > BEHAVIOR.text) return fail(`a behavior line must be 1-${BEHAVIOR.text} characters`);
      if (rows.length >= BEHAVIOR.lines) return fail(`already ${BEHAVIOR.lines} behavior lines: replace or forget one (keys: ${rows.map(r => r.key).join(", ")})`);
      rows.push({ ...line, text });
    }
    await writeFileAtomic(file(scope), JSON.stringify(rows, null, 2));
    return ok(rows);
  });
}
