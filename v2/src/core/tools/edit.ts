import { fail, ok, type Result } from "../../config";
import { mutate, type Change } from "./atomic";
import { filePath } from "./path";
import { settled, type Tool } from "./registry";

const PREVIEW_BYTES = 1000, PREVIEW_LINE_BYTES = 200;
const lineAt = (text: string, offset: number) => { let n = 1; for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) n++; return n; };
const clip = (line: string) => Buffer.byteLength(line) <= PREVIEW_LINE_BYTES ? line
  : Buffer.from(line).subarray(0, PREVIEW_LINE_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "…";
export function editPreview(text: string, regions: { start: number; end: number }[]): string {
  const lines = text.split("\n"), out: string[] = [];
  let bytes = 0, last = 0, shown = 0;
  for (const region of regions) {
    const from = Math.max(1, lineAt(text, region.start) - 1), to = Math.min(lines.length, lineAt(text, region.end) + 1);
    for (let n = Math.max(from, last + 1); n <= to; n++) {
      const row = `${n}: ${clip(lines[n - 1] ?? "")}`, gap = last > 0 && n > last + 1 ? "…\n" : "";
      if (bytes + Buffer.byteLength(gap + row) + 1 > PREVIEW_BYTES) {
        return [...out, `[preview truncated before line ${n}; ${shown} of ${regions.length} changed region${regions.length === 1 ? "" : "s"} shown in full]`].join("\n");
      }
      if (gap !== "") out.push("…");
      out.push(row); bytes += Buffer.byteLength(gap + row) + 1; last = n;
    }
    shown++;
  }
  return out.join("\n");
}
function occurrences(text: string, needle: string, step: number): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + step)) found.push(i);
  return found;
}
const some = (numbers: number[], max = 12) => numbers.slice(0, max).join(", ") + (numbers.length > max ? ", …" : "");
function noMatch(text: string, old: string): string {
  const wanted = old.split("\n").map(l => l.trim()).find(l => l !== ""), lines = text.split("\n");
  const near = wanted !== undefined ? lines.flatMap((l, i) => l.trim() === wanted ? [i + 1] : []) : [];
  const first = near[0];
  const where = first === undefined ? "" : ` Its first line appears, with different whitespace or different following lines, at line ${some(near, 5)}: ${JSON.stringify(clip(lines[first - 1] ?? ""))}.`;
  return `old_text not found (0 matches); nothing was changed. It must match the file exactly, including whitespace and indentation.${where}`;
}

export const edit: Tool = {
  parallel: () => false,
  spec: { name: "edit", description: "Change a UTF-8 file by exact text replacement, in one call: no prior read or revision is needed, the exact match of old_text is the check. old_text must match exactly one location unless replace_all is true; a failure changes nothing and names the matching lines. Returns a numbered preview of the changed lines, so there is no need to re-read.",
    input_schema: { type: "object", properties: {
      path: { type: "string" },
      old_text: { type: "string", description: "Exact text to replace, with its whitespace; include enough surrounding text to be unique." },
      new_text: { type: "string" },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_text instead of requiring a single match. Default false." },
      expected_revision: { type: "string", description: "Optional revision from read; when given, the edit is refused if the file has changed since." },
    }, required: ["path", "old_text", "new_text"] } },
  async run(input, ctx) {
    if (typeof input.old_text !== "string" || input.old_text === "" || typeof input.new_text !== "string") throw new Error("old_text must be nonempty; new_text must be a string");
    if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") throw new Error("replace_all must be a boolean");
    if (input.expected_revision !== undefined && typeof input.expected_revision !== "string") throw new Error("expected_revision must be a string when given");
    const old = input.old_text, next = input.new_text, all = input.replace_all === true;
    if (old === next) throw new Error("old_text and new_text are identical; nothing to change");
    return settled(await mutate(settled(await filePath(input.path, ctx, true)), input.expected_revision, (text): Result<Change> => {
      const found = occurrences(text, old, all ? old.length : 1);
      if (found.length === 0) return fail(noMatch(text, old));
      if (found.length > 1 && !all) return fail(`old_text matches ${found.length} locations (lines ${some(found.map(i => lineAt(text, i)))}); nothing was changed. Add surrounding text so it matches one, or set replace_all to true to replace all ${found.length}.`);
      let result = "", at = 0;
      const regions = found.map(i => { result += text.slice(at, i); const start = result.length; result += next; at = i + old.length; return { start, end: result.length }; });
      result += text.slice(at);
      return ok({ text: result, report: { ...(all ? { replacements: found.length } : {}), preview: editPreview(result, regions) } });
    }, false));
  },
};
