// MOCKUP-PICK (throwaway): shared helpers for the Ctrl+T task-list variants. Deleted after the pick.
import { taskPublicationMilestone, type TaskPR } from "../../protocol/task";
import { active, activity, statusColor, type OutlineNode } from "./task-tree";
import type { TreeTask } from "./task-tree-data";
import { cells, fit, LINK_CLOSE, linkOpen, plainText, visibleLength, wordWrap, wrap } from "./text";
import { noColour } from "./style";

export const STAGES = ["queued", "worker", "review", "PR", "merged"] as const;
export interface Info {
  task: TreeTask; id: string; number: number; name: string; summary: string;
  color: number; stage: number; label: string; active: boolean; activity: string;
  attention?: TreeTask["attention"]; stopped: boolean; pr?: TaskPR;
  deps: Info[]; dependents: Info[]; waitsOn: Info[]; reviews: number; updatedAt: string;
}
/** One painted line; `ids` are clickable spans (cols in cells), absent for headers/rules. */
export interface Row { text: string; ids?: { id: string; col: number; width: number }[] }
export interface Ctx {
  all: Info[]; visible: Info[]; outline: OutlineNode[]; cols: number; rows: number;
  frame: number; requested?: string; collapsed: ReadonlySet<string>;
}
export interface Layout {
  /** Rows pinned above the scrolling body (column headers). */
  head?: Row[]; rows: Row[];
  /** Board only: task ids per column, for ← → between columns. */
  columns?: string[][]; order: string[]; selectedId?: string; nodes?: OutlineNode[];
  /** bottom panel, right side panel, or none (details already in `rows`). */
  detail: "bottom" | "side" | "none"; details?: string[]; sideCols?: number; bodyShare?: number; legend?: string;
}

/** Side panel width for a full width; 0 means too narrow, use a bottom panel. */
export const sideCols = (cols: number, min = 100) => cols >= min ? Math.min(60, Math.max(36, Math.floor(cols * 0.42))) : 0;

export const paint = (code: number | string, s: string) => noColour() ? s : `\x1b[${code}m${s}\x1b[0m`;
export const dimmed = (s: string) => paint(2, s);
export const strong = (s: string) => paint(1, s);
export const dot = (i: Info, glyph = "●") => paint(i.color, glyph);
const SPIN = ["◐", "◓", "◑", "◒"];
export const spinner = (frame: number) => SPIN[frame % 4]!;

/** Fit to exactly `cols` cells (pad or clip with …). */
export function cell(s: string, cols: number): string {
  if (cols <= 0) return "";
  const f = fit(s, cols);
  return f + " ".repeat(Math.max(0, cols - visibleLength(f)));
}
/** Left text and right text on one line of `cols`; the left is clipped first. */
export function spread(left: string, right: string, cols: number): string {
  const rw = visibleLength(right);
  if (rw + 2 > cols) return fit(left, cols);
  return cell(left, cols - rw - 1) + " " + right;
}
export function lines(value: string, cols: number): string[] {
  const out: string[] = [];
  for (const line of wordWrap(plainText(value), Math.max(1, cols))) for (const piece of wrap(line, Math.max(1, cols))) out.push(piece);
  return out.length ? out : [""];
}
/** Plain clip of an untrusted field to `cols` cells, grapheme-safe. */
export function clip(s: string, cols: number): string {
  const text = plainText(s);
  if (visibleLength(text) <= cols) return text;
  if (cols <= 1) return cols === 1 ? "…" : "";
  let r = "", w = 0;
  for (const c of cells(text)) { if (w + c.width > cols - 1) break; r += c.text; w += c.width; }
  return r + "…";
}
export const row = (text: string, id?: string, col = 0, width = Number.MAX_SAFE_INTEGER): Row => ({ text, ids: id ? [{ id, col, width }] : undefined });

export function ago(at: string, now = Date.now()): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "?";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function stageOf(task: TreeTask): number {
  if (task.archive) return 4;
  if (taskPublicationMilestone(task).kind !== "unknown" || task.pr || task.status === "ready_to_merge") return 3;
  if (task.status === "reviewing" || task.runs.some(r => r.role === "reviewer")) return 2;
  if (task.status === "working" || task.runs.some(r => r.role === "worker")) return 1;
  return 0;
}

/** One plain label, the inbox rule: attention first, then lifecycle/publication. */
function labelOf(task: TreeTask, stage: number): string {
  if (task.archive) return "merged";
  if (task.attention) return task.attention.kind;
  if (task.status === "ready_to_merge") return "ready to merge";
  if (stage === 3) return taskPublicationMilestone(task).kind === "closed" ? "PR closed" : "PR open";
  return task.status;
}

export function infos(tasks: TreeTask[], outline: OutlineNode[]): { all: Info[]; visible: Info[] } {
  const all = tasks.map((task, i): Info => {
    const stage = stageOf(task), kind = task.attention?.kind;
    return {
      task, id: task.id, number: task.number ?? i + 1, name: plainText(task.name), summary: plainText(task.summary),
      color: statusColor(task), stage, label: labelOf(task, stage), active: active(task), activity: activity(task),
      attention: task.attention, stopped: kind === "blocked" || kind === "cancelled" || kind === "closed" || kind === "unknown",
      pr: task.archive?.pr ?? task.pr, deps: [], dependents: [], waitsOn: [],
      reviews: task.runs.filter(r => r.role === "reviewer").length, updatedAt: task.updatedAt,
    };
  });
  const by = new Map(all.map(i => [i.id.toLowerCase(), i]));
  for (const i of all) {
    i.deps = i.task.dependsOn.map(d => by.get(d.toLowerCase())!).filter(Boolean);
    for (const d of i.deps) d.dependents.push(i);
    i.waitsOn = i.deps.filter(d => d.stage < 4);
  }
  const order = new Map(outline.map((n, k) => [n.id, k]));
  const visible = all.filter(i => !i.task.removedAt).sort((a, b) => a.number - b.number || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { all, visible };
}

export const pick = (order: string[], requested?: string) => order.includes(requested ?? "") ? requested : order[0];

/** worker → review → PR → merged as glyphs; the current stage spins when active, ✕ when stopped. */
export function track(i: Info, frame: number, gap = "──"): string {
  const parts: string[] = [];
  for (let s = 1; s <= 4; s++) {
    const done = s < i.stage || i.stage === 4;
    const here = s === i.stage && i.stage < 4;
    let g = done ? paint(i.stage === 4 ? 35 : 32, "●") : here ? (i.stopped ? paint(31, "✕") : i.active ? paint(36, spinner(frame)) : paint(i.color, "◉")) : dimmed("○");
    if (s === 1 && i.stage === 0 && i.stopped) g = paint(31, "✕");
    parts.push(g);
  }
  return parts.map((g, k) => k ? (k < Math.max(1, i.stage) || i.stage === 4 ? paint(i.stage === 4 ? 35 : 32, gap) : dimmed(gap.replace(/─/g, "┄"))) + g : g).join("");
}
export const trackWidth = (gap = "──") => 4 + 3 * visibleLength(gap);

export function prText(i: Info, link = true): string {
  if (!i.pr) return dimmed("no PR");
  const t = `#${i.pr.number}`;
  return link ? `${linkOpen(i.pr.url)}${paint(i.stage === 4 ? 35 : 32, t)}${LINK_CLOSE}` : t;
}
export const depRef = (d: Info) => `${dot(d, d.stage === 4 ? "✓" : "●")}${d.stage === 4 ? dimmed(`#${d.number}`) : `#${d.number}`}`;

/** The full details block shared by bottom/side/in-place panels. */
export function richDetails(i: Info | undefined, cols: number, frame: number, show: { title?: boolean; deps?: boolean } = {}): string[] {
  if (!i) return [dimmed("No tasks yet — the orchestrator registers them as work is dispatched.")];
  const out: string[] = [];
  const kv = (k: string, v: string) => {
    const w = Math.max(1, cols - 10);
    const vs = v.includes("\x1b") ? [fit(v, w)] : lines(v, w);
    vs.forEach((line, n) => out.push(fit(`${n ? " ".repeat(10) : dimmed(k.padEnd(10))}${line}`, cols)));
  };
  if (show.title !== false) for (const l of lines(`#${i.number} ${i.name}`, cols)) out.push(strong(l));
  out.push(fit(`${dot(i)} ${paint(i.color, i.label)}${i.active ? dimmed(` · ${i.activity}`) : ""}   ${track(i, frame)} ${dimmed("worker→review→PR→merged")}`, cols));
  if (i.attention) kv(i.attention.kind, i.attention.reason);
  kv("PR", i.pr ? `${prText(i)} ${dimmed(i.pr.repository)}` : dimmed("not opened yet"));
  if (show.deps !== false) kv("Needs", i.deps.length ? i.deps.map(d => `${depRef(d)} ${clip(d.name, 18)}`).join("  ") : dimmed("nothing"));
  if (show.deps !== false && i.dependents.length) kv("Unblocks", i.dependents.map(d => `${depRef(d)} ${clip(d.name, 18)}`).join("  "));
  kv("Branch", `${i.task.branch} · updated ${ago(i.updatedAt)} ago`);
  const runs = i.task.runs.slice(-3).map(r => `${r.role} ${r.state}`).join(", ");
  if (runs) kv("Runs", runs + (i.task.runs.length > 3 ? ` (+${i.task.runs.length - 3})` : ""));
  if (i.task.readiness) kv("Checks", `${i.task.readiness.checks}: ${i.task.readiness.validation}`);
  kv("Summary", i.summary || "—");
  out.push(fit(dimmed(i.id), cols));
  return out;
}

/** Two or three lines: for compact bottom panels. */
export function peek(i: Info | undefined, cols: number, frame: number): string[] {
  if (!i) return [dimmed("No tasks.")];
  const head = spread(`${dot(i)} ${strong(`#${i.number} ${i.name}`)}`, `${paint(i.color, i.label)} ${track(i, frame, "─")}`, cols);
  const deps = i.deps.length ? `needs ${i.deps.map(depRef).join(" ")}` : "no deps";
  const second = fit(`${prText(i)}  ${dimmed(deps)}${i.dependents.length ? dimmed(`  unblocks ${i.dependents.map(d => `#${d.number}`).join(" ")}`) : ""}`, cols);
  const third = i.attention ? fit(paint(31, `⚠ ${i.attention.kind}: `) + plainText(i.attention.reason), cols) : fit(dimmed(i.summary), cols);
  return [head, second, third];
}

export const LEGEND = `${paint(35, "●")} merged ${paint(32, "●")} PR ${paint(31, "●")} stopped ${paint(33, "●")} unknown ${paint(36, "●")} active ${paint(90, "●")} queued`;
