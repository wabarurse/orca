/** Replace the entire conflicting repair block, never individual unsuccessful trials. */
import { join } from "node:path";
import { jsonLines } from "./metrics";
const dir = join(import.meta.dir, "results");
const original = jsonLines(await Bun.file(join(dir, "live.audited.jsonl")).text());
const direct = jsonLines(await Bun.file(join(dir, "direct-repair.audited.jsonl")).text());
if (original.length !== 90 || direct.length !== 18 || direct.some(r => r.task !== "repair" || r.directMode !== true)) throw new Error("Incomplete study blocks");
const primary = [...original.filter(r => r.task !== "repair"), ...direct];
const keys = primary.map(r => `${r.arm}/${r.task}/${r.repeat}`);
if (primary.length !== 90 || new Set(keys).size !== 90) throw new Error("Duplicate or missing primary trials");
await Bun.write(join(dir, "primary.audited.jsonl"), primary.map(r => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ totalTrials: original.length + direct.length, original: { passed: original.filter(r=>r.success).length, n: original.length },
  originalRepairs: { passed: original.filter(r=>r.task==="repair" && r.success).length, n: 18 },
  directRepairs: { passed: direct.filter(r=>r.success).length, n: direct.length },
  primary: { passed: primary.filter(r=>r.success).length, n: primary.length } }, null, 2));
