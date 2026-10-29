// MOCKUP-PICK (throwaway): print every Ctrl+T task-list variant with shared sample tasks.
//   bun scripts/mockup-pick-tasks.ts [cols] [rows] [letters]   e.g. `bun scripts/mockup-pick-tasks.ts 120 32 ABC`
// Pure rendering of fixture records: reads and writes nothing; ORCA_HOME is pointed at a fresh temp dir anyway.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ORCA_HOME = mkdtempSync(join(tmpdir(), "orca-mockup-"));
const { renderTaskTreeVariant, VARIANTS } = await import("../src/tui/components/task-tree-mockup");
type Task = import("../src/protocol/task").Task;

const cols = Number(process.argv[2]) || 120, rows = Number(process.argv[3]) || 30;
const only = (process.argv[4] ?? "").toUpperCase();
const NOW = Date.now(), at = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const head = (c: string) => c.repeat(40);
const pr = (n: number, h = "a") => ({ repository: "wabarurse/orca", number: n, url: `https://github.com/wabarurse/orca/pull/${n}`, head: head(h) });
const run = (role: "worker" | "reviewer", state: "started" | "stopped" | "failed", minutes: number) =>
  ({ id: `${role}-${minutes}`, agent: `${role}-x`, role, state, preparedAt: at(minutes + 1), startedAt: at(minutes), ...(state === "started" ? {} : { endedAt: at(minutes - 5) }) });
function task(n: number, name: string, extra: Partial<Task> = {}, minutes = n * 37): Task {
  return { id: id(n), number: n, name, summary: `Summary for ${name.toLowerCase()}.`, branch: `feat-${n}`, status: "queued",
    createdAt: at(minutes + 600), updatedAt: at(minutes), revision: 1, dependsOn: [], runs: [], history: [], ...extra };
}
const merged = (n: number, h: string) => ({ reason: "merged" as const, mergedAt: at(3000), archivedAt: at(2990), pr: pr(n, h) });

const SAMPLE: Task[] = [
  task(1, "Structure orchestrator rolling memory", { archive: merged(171, "b"), pr: pr(171, "b"), runs: [run("worker", "stopped", 3100), run("reviewer", "stopped", 3050)] }, 2990),
  task(2, "Keep slow work out of the project state lock", { archive: merged(172, "c"), pr: pr(172, "c"), removedAt: at(100) }, 2400),
  task(3, "Delete questions from the Inbox when outdated or answered in chat", { status: "working", dependsOn: [id(1)], runs: [run("worker", "started", 12)] }, 2),
  task(4, "read returns images; actionable write-exists error", { status: "reviewing", runs: [run("worker", "stopped", 90), run("reviewer", "started", 8)] }, 8),
  task(5, "/agents hides finished agents and can remove rows", { status: "reviewing", pr: pr(181, "d"),
    publication: { pr: pr(181, "d"), state: "OPEN", observedAt: at(30) }, checkpoints: { prOpenAt: at(30) }, runs: [run("worker", "stopped", 200), run("reviewer", "stopped", 40)] }, 30),
  task(6, "Provider timeout fix with jittered backoff", { status: "ready_to_merge", pr: pr(179, "e"),
    publication: { pr: pr(179, "e"), state: "OPEN", observedAt: at(300) }, readiness: { head: head("e"), run: "reviewer-50", validatedAt: at(290), validation: "bun run check passed; 2 review rounds", checks: "passed" },
    runs: [run("worker", "stopped", 600), run("reviewer", "stopped", 400), run("reviewer", "stopped", 300)] }, 290),
  task(7, "Compaction cost vs recall experiment", { status: "working", attention: { kind: "waiting", reason: "Waiting on the user's backoff decision" }, runs: [run("worker", "stopped", 900)] }, 880),
  task(8, "Rebuild the markdown table renderer for narrow terminals, keeping wide-character alignment and soft-wrapped cells readable everywhere", {
    status: "working", attention: { kind: "blocked", reason: "Needs a decision: drop column borders below 60 cols?" }, runs: [run("worker", "failed", 1500)] }, 1500),
  task(9, "Migrate legacy task ledger", { attention: { kind: "cancelled", reason: "Superseded by the SQLite store" } }, 4000),
  task(10, "Hosted CI for PRs", { status: "reviewing", pr: pr(150, "f"), publication: { pr: pr(150, "f"), state: "CLOSED", observedAt: at(5000) },
    attention: { kind: "closed", reason: "PR closed without merge" }, runs: [run("worker", "stopped", 5200)] }, 5000),
  task(11, "Worker crash notice", { status: "working", attention: { kind: "unknown", reason: "Run vanished; no exit record" }, runs: [run("worker", "failed", 60)] }, 60),
  task(12, "Document the task overlay", { dependsOn: [id(3), id(5)] }, 20),
  task(13, "Ship task overlay redesign", { dependsOn: [id(12)] }, 19),
  task(14, "Profile footer redraws", {}, 9000),
];

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
