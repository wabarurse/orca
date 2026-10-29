// MOCKUP-PICK (throwaway): print every Ctrl+T task-list variant with shared sample tasks.
//   bun scripts/mockup-pick-tasks.ts [cols] [rows] [letters]   e.g. `bun scripts/mockup-pick-tasks.ts 120 32 ABC`
// Pure rendering of fixture records: reads and writes nothing; ORCA_HOME is pointed at a fresh temp dir anyway.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ORCA_HOME = mkdtempSync(join(tmpdir(), "orca-mockup-"));
const { renderTaskTreeVariant, VARIANTS } = await import("../src/tui/components/task-tree-mockup");
type Task = import("../src/protocol/task").Task;
const { SAMPLE, id } = await import("./mockup-pick-tasks-fixtures");

const cols = Number(process.argv[2]) || 120, rows = Number(process.argv[3]) || 30;
const only = (process.argv[4] ?? "").toUpperCase();
const sample = (n: number) => SAMPLE.slice(0, n);
const letters = VARIANTS.map((v, k) => [k + 1, v] as const).filter(([, v]) => !only || only.includes(v.letter));
const box = (title: string, lines: string[], width: number) => {
  console.log(`\x1b[2m┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 3))}┐\x1b[0m`);
  for (const line of lines) console.log(`\x1b[2m│\x1b[0m${line}\x1b[0m${" ".repeat(Math.max(0, width - Bun.stringWidth(line)))}\x1b[2m│\x1b[0m`);
  console.log(`\x1b[2m└${"─".repeat(width)}┘\x1b[0m\n`);
};
const show = (variant: number, tasks: Task[], w: number, h: number, label: string, selectedId?: string) => {
  const out = renderTaskTreeVariant(tasks, { cols: w, rows: h, variant, selectedId, frame: 1, revealSelected: true });
  if (out.errors.length) throw new Error(`variant ${variant} ${label}: ${out.errors.join("; ")}`);
  if (out.lines.length > h) throw new Error(`variant ${variant} ${label}: ${out.lines.length} lines > ${h}`);
  for (const line of out.lines) if (Bun.stringWidth(line) > w) throw new Error(`variant ${variant} ${label}: a line is ${Bun.stringWidth(line)} > ${w} cells`);
  box(label, out.lines, w);
};

for (const [variant, v] of letters) {
  console.log(`\x1b[1m━━ ${v.letter} · ${v.name}\x1b[0m — ${v.idea}\n`);
  show(variant, SAMPLE, cols, rows, `${v.letter} ${cols}×${rows} · all statuses, #8 selected (long name, blocked)`, id(8));
  show(variant, SAMPLE, Math.min(cols, 60), Math.min(rows, 22), `${v.letter} narrow 60×22 · #3 selected (working, depends on merged #1)`, id(3));
  show(variant, sample(0), Math.min(cols, 80), 8, `${v.letter} empty list`);
}
if (!only || only.includes("0")) show(0, SAMPLE, cols, rows, `0 today's outline ${cols}×${rows}`);
console.log(`\x1b[2mORCA_HOME=${process.env.ORCA_HOME} (untouched)\x1b[0m`);
