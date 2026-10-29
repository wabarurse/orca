// MOCKUP-PICK (throwaway): eight Ctrl+T task-list variants over the same Task records. Deleted after the pick.
import type { OutlineNode } from "./task-tree";
import { fit } from "./text";
import {
  ago, cell, clip, depRef, dimmed, dot, LEGEND, paint, peek, pick, prText, richDetails, row, sideCols, spinner,
  spread, strong, track, type Ctx, type Info, type Layout, type Row,
} from "./task-tree-mockup-kit";

const mark = (on: boolean) => on ? paint(1, "▶") : " ";
const title = (i: Info, on: boolean, cols: number) => on ? strong(clip(`#${i.number} ${i.name}`, cols)) : clip(`#${i.number} ${i.name}`, cols);
const waits = (i: Info) => i.waitsOn.length ? paint(33, `⧗ after ${i.waitsOn.map(d => `#${d.number}`).join(",")}`) : "";
const live = (i: Info, frame: number) => i.active ? paint(36, spinner(frame)) + " " : "";

// A — Lanes: grouped by what needs doing, one line each, rich details at the bottom.
function lanes(ctx: Ctx): Layout {
  const groups: [string, number, (i: Info) => boolean][] = [
    ["NEEDS YOU", 31, i => i.stopped && i.stage < 4],
    ["IN FLIGHT", 36, i => !i.stopped && (i.stage === 1 || i.stage === 2)],
    ["PR OUT", 32, i => !i.stopped && i.stage === 3],
    ["QUEUED", 90, i => !i.stopped && i.stage === 0],
    ["MERGED", 35, i => i.stage === 4],
  ];
  const sections = groups.map(([name, code, test]) => ({ name, code, items: ctx.visible.filter(test) })).filter(g => g.items.length);
  const order = sections.flatMap(g => g.items.map(i => i.id)), selectedId = pick(order, ctx.requested);
  const rows: Row[] = [];
  for (const g of sections) {
    if (rows.length) rows.push(row(""));
    rows.push(row(fit(`${paint(g.code, "▾ " + g.name)} ${dimmed(String(g.items.length))}`, ctx.cols)));
    const reasonCols = Math.max(8, Math.min(36, Math.floor(ctx.cols / 3)));
    for (const i of g.items) {
      const right = i.stopped ? paint(31, clip(i.attention?.reason ?? i.label, reasonCols))
        : i.stage === 3 ? prText(i) + dimmed(i.task.status === "ready_to_merge" ? " ready" : "")
        : i.stage === 4 ? dimmed(`${ago(i.updatedAt)} ago`)
        : i.waitsOn.length ? waits(i) : dimmed(i.activity || i.label);
      const on = i.id === selectedId;
      rows.push(row(spread(`${mark(on)} ${live(i, ctx.frame) || dot(i) + " "}${title(i, on, ctx.cols)}`, right, ctx.cols), i.id));
    }
  }
  const selected = ctx.visible.find(i => i.id === selectedId);
  return { rows, order, selectedId, detail: "bottom", details: richDetails(selected, ctx.cols, ctx.frame), bodyShare: 0.5, legend: LEGEND };
}

// B — Pipeline: every row is a worker → review → PR → merged track; details on the right when wide.
function pipeline(ctx: Ctx): Layout {
  const side = sideCols(ctx.cols, 110), cols = side ? ctx.cols - side - 3 : ctx.cols;
  const wide = cols >= 64, gap = wide ? "─────" : "──", tw = wide ? 21 : 12;
  const labels = wide ? "wrk   rev   PR    mrg" : "w  r  P  m  ";
  const order = ctx.visible.map(i => i.id), selectedId = pick(order, ctx.requested);
  const nameCols = Math.max(6, cols - tw - 2 - 14);
  const head = [row(dimmed(fit(`  ${"TASK".padEnd(nameCols)} ${labels.padEnd(tw)}  NOTE`, cols)))];
  const rows = ctx.visible.map(i => {
    const on = i.id === selectedId;
    const note = i.stopped ? paint(31, `✕ ${i.attention!.kind}`) : i.waitsOn.length ? waits(i) : i.stage === 4 ? dimmed("merged") : i.stage === 3 ? prText(i) + (i.task.status === "ready_to_merge" ? paint(32, " ✓ ready") : "") : i.active ? dimmed(i.activity) : "";
    return row(fit(`${mark(on)} ${cell(title(i, on, nameCols), nameCols)} ${cell(track(i, ctx.frame, gap), tw)}  ${note}`, cols), i.id, 0, cols);
  });
  const selected = ctx.visible.find(i => i.id === selectedId);
  return { head, rows, order, selectedId, detail: side ? "side" : "bottom", sideCols: side || undefined,
    details: richDetails(selected, side || ctx.cols, ctx.frame), bodyShare: 0.55, legend: dimmed("● done  ◉ here  ◐ running  ✕ stopped  ○ not yet") };
}

// C — Board: kanban status columns, two-line cards; ← → move between columns.
function board(ctx: Ctx): Layout {
  const five = Math.floor((ctx.cols - 4) / 5) >= 13;
  const defs: [string, number, (i: Info) => boolean][] = five
    ? [["QUEUED", 90, i => i.stage === 0], ["WORKER", 36, i => i.stage === 1], ["REVIEW", 36, i => i.stage === 2], ["PR", 32, i => i.stage === 3], ["MERGED", 35, i => i.stage === 4]]
    : [["TO DO", 90, i => i.stage === 0], ["DOING", 36, i => i.stage === 1 || i.stage === 2], ["DONE", 32, i => i.stage >= 3]];
  const columns = defs.map(([name, code, test]) => ({ name, code, items: ctx.visible.filter(test) }));
  const ids = columns.map(c => c.items.map(i => i.id));
  const order = ids.flat(), selectedId = pick(order, ctx.requested);
  const w = Math.max(4, Math.floor((ctx.cols - (columns.length - 1)) / columns.length));
  const cards = columns.map(c => c.items.flatMap(i => {
    const on = i.id === selectedId, bar = on ? paint(i.color, "▌") : " ";
    const flag = i.stopped ? paint(31, ` ✕ ${i.attention!.kind}`) : i.active ? " " + paint(36, spinner(ctx.frame)) : i.waitsOn.length ? paint(33, " ⧗") : "";
    const sub = i.stopped ? paint(31, clip(i.attention!.reason, w - 2)) : i.waitsOn.length ? dimmed(`after ${i.waitsOn.map(d => "#" + d.number).join(" ")}`)
      : i.pr ? prText(i) + dimmed(i.task.status === "ready_to_merge" ? " ✓ready" : "") : dimmed(i.label);
    return [
      { id: i.id, text: `${bar}${dot(i)} ${on ? strong("#" + i.number) : "#" + i.number}${flag}` },
      { id: i.id, text: `${bar}${on ? strong(clip(i.name, w - 1)) : clip(i.name, w - 1)}` },
      { id: i.id, text: `${bar}${sub}` },
      { id: undefined, text: "" },
    ];
  }));
  const sep = dimmed("│");
  const head = [
    row(columns.map(c => cell(`${paint(c.code, c.name)} ${dimmed(String(c.items.length))}`, w)).join(sep)),
    row(dimmed(columns.map(() => "─".repeat(w)).join("┼"))),
  ];
  const height = Math.max(1, ...cards.map(c => c.length));
  const rows: Row[] = [];
  for (let r = 0; r < height; r++) {
    const ids: NonNullable<Row["ids"]> = [];
    const text = cards.map((c, k) => {
      const line = c[r];
      if (line?.id) ids.push({ id: line.id, col: k * (w + 1), width: w });
      return cell(line?.text ?? (r === 0 && !c.length ? dimmed("  —") : ""), w);
    }).join(sep);
    rows.push({ text, ids });
  }
  const selected = ctx.visible.find(i => i.id === selectedId);
  return { head, rows, order, selectedId, columns: ids, detail: "bottom", details: peek(selected, ctx.cols, ctx.frame), bodyShare: 0.8,
    legend: dimmed("← → column · ↑↓ card · ✕ stopped · ⧗ waiting on a prerequisite") };
}

// D — Cards: two-line cards; the selected card expands in place with every detail.
function cards(ctx: Ctx): Layout {
  const order = ctx.visible.map(i => i.id), selectedId = pick(order, ctx.requested), cols = ctx.cols;
  const rows: Row[] = [];
  for (const i of ctx.visible) {
    const on = i.id === selectedId, bar = on ? paint(i.color, "┃ ") : "  ";
    const right = `${i.pr ? prText(i) + dimmed(" · ") : ""}${paint(i.color, i.label)}`;
    rows.push(row(spread(`${bar}${live(i, ctx.frame) || dot(i) + " "}${title(i, on, cols)}`, right, cols), i.id));
    const meta = [i.waitsOn.length ? `after ${i.waitsOn.map(d => "#" + d.number).join(" ")}` : "", `${ago(i.updatedAt)} ago`].filter(Boolean).join(" · ");
    rows.push(row(spread(`${bar}  ${dimmed(clip(i.attention ? `${i.attention.kind}: ${i.attention.reason}` : i.summary, cols))}`, dimmed(meta), cols), i.id));
    if (on) for (const line of richDetails(i, cols - 6, ctx.frame, { title: false })) rows.push(row(`${bar}    ${line}`, i.id));
    rows.push(row(""));
  }
  if (!rows.length) rows.push(row(dimmed("  No tasks yet.")));
  return { rows, order, selectedId, detail: "none", legend: dimmed("↑↓ card (expands in place) · PgUp/PgDn scroll") };
}

// E — Split: master list on the left, details with a dependency mini-graph on the right.
function depGraph(i: Info, cols: number): string[] {
  const out: string[] = [strong("Dependencies")];
  const ref = (d: Info) => fit(`${depRef(d)} ${clip(d.name, cols - 14)} ${dimmed(d.label)}`, cols - 10);
  if (!i.deps.length && !i.dependents.length) return [...out, dimmed("  independent — nothing before or after it"), ""];
  i.deps.forEach((d, k) => out.push(`${dimmed(k ? "          " : "needs     ")}${ref(d)}`));
  if (i.deps.length) out.push(`${" ".repeat(11)}${dimmed("│")}`);
  out.push(`${" ".repeat(10)}${paint(i.color, "◆")} ${strong(clip(`#${i.number} ${i.name}`, cols - 13))}`);
  if (i.dependents.length) out.push(`${" ".repeat(11)}${dimmed("│")}`);
  i.dependents.forEach((d, k) => out.push(`${dimmed(k ? "          " : "unblocks  ")}${ref(d)}`));
  return [...out, ""];
}
function split(ctx: Ctx): Layout {
  const side = ctx.cols >= 90 ? Math.max(36, ctx.cols - Math.min(44, Math.floor(ctx.cols * 0.36)) - 3) : 0;
  const cols = side ? ctx.cols - side - 3 : ctx.cols;
  const byId = new Map(ctx.visible.map(i => [i.id, i]));
  const order = ctx.outline.map(n => n.id), selectedId = pick(order, ctx.requested);
  const rows = ctx.outline.map(n => {
    const i = byId.get(n.id)!, on = i.id === selectedId;
    const indent = n.depth ? "  ".repeat(Math.min(n.depth - 1, 4)) + dimmed("└ ") : "";
    const text = `${indent}${live(i, ctx.frame) || dot(i) + " "}${clip(`#${i.number} ${i.name}`, cols)}`;
    return row(on ? paint(7, cell(" " + Bun.stripANSI(text), cols)) : fit(" " + text, cols), i.id, 0, cols);
  });
  const selected = byId.get(selectedId ?? "");
  const details = selected ? [...depGraph(selected, side || ctx.cols), ...richDetails(selected, side || ctx.cols, ctx.frame, { deps: false })] : richDetails(undefined, ctx.cols, 0);
  return { rows, order, selectedId, nodes: ctx.outline, detail: side ? "side" : "bottom", sideCols: side || undefined, details, bodyShare: 0.4, legend: LEGEND };
}

// F — Tree: the dependency outline with box connectors, fold markers and right-aligned labels.
function tree(ctx: Ctx): Layout {
  const byId = new Map(ctx.visible.map(i => [i.id, i]));
  const nodes = new Map(ctx.outline.map(n => [n.id, n]));
  const roots = ctx.outline.filter(n => n.depth === 0).map(n => n.id);
  const last = (n: OutlineNode) => { const sib = n.parent ? nodes.get(n.parent)!.children : roots; return sib.at(-1) === n.id; };
  const order = ctx.outline.map(n => n.id), selectedId = pick(order, ctx.requested);
  const rows = ctx.outline.map(n => {
    const i = byId.get(n.id)!, on = i.id === selectedId;
    let prefix = "";
    for (let a = n.parent ? nodes.get(n.parent) : undefined; a && a.depth > 0; a = a.parent ? nodes.get(a.parent) : undefined) prefix = (last(a) ? "   " : "│  ") + prefix;
    const conn = n.depth ? (last(n) ? "└─ " : "├─ ") : "";
    const fold = n.children.length ? (ctx.collapsed.has(n.id) ? paint(1, "▸ ") : "▾ ") : "";
    const extra = i.deps.filter(d => d.id !== n.parent).map(d => `+#${d.number}`).join(" ");
    const hidden = n.children.length && ctx.collapsed.has(n.id) ? dimmed(` (${n.children.length} hidden)`) : "";
    const right = `${extra ? dimmed(extra) + " " : ""}${paint(i.color, i.label)}`;
    return row(spread(`${mark(on)} ${dimmed(prefix + conn)}${fold}${live(i, ctx.frame) || dot(i) + " "}${title(i, on, ctx.cols)}${hidden}`, right, ctx.cols), i.id);
  });
  const selected = byId.get(selectedId ?? "");
  return { rows, order, selectedId, nodes: ctx.outline, detail: "bottom", details: peek(selected, ctx.cols, ctx.frame), bodyShare: 0.8,
    legend: dimmed("├─ first prerequisite  +#n other prerequisites  ← fold  → unfold") };
}

// G — Table: gh-style columns, reverse-video selection, a two-line peek opens under the selected row.
function table(ctx: Ctx): Layout {
  const order = ctx.visible.map(i => i.id), selectedId = pick(order, ctx.requested), cols = ctx.cols;
  type Col = { name: string; width: number; rank: number; get: (i: Info) => [string, number?] };
  const all: Col[] = [
    { name: "#", width: 4, rank: 0, get: i => [`#${i.number}`] },
    { name: "STATUS", width: 16, rank: 0, get: i => [`${i.active ? spinner(ctx.frame) : "●"} ${i.label}`, i.color] },
    { name: "TASK", width: 0, rank: 0, get: i => [i.name] },
    { name: "AGE", width: 4, rank: 1, get: i => [ago(i.updatedAt)] },
    { name: "PR", width: 6, rank: 2, get: i => [i.pr ? `#${i.pr.number}` : "—", i.pr ? (i.stage === 4 ? 35 : 32) : 90] },
    { name: "DEPS", width: 9, rank: 3, get: i => [i.deps.map(d => (d.stage === 4 ? "✓" : "") + d.number).join(",") || "—", i.waitsOn.length ? 33 : 90] },
    { name: "REV", width: 4, rank: 4, get: i => [i.reviews ? `r${i.reviews}${i.task.readiness ? "✓" : ""}` : "—"] },
  ];
  const shown = all.filter(c => c.rank <= (cols >= 100 ? 4 : cols >= 84 ? 3 : cols >= 70 ? 2 : cols >= 56 ? 1 : 0));
  const fixed = shown.reduce((n, c) => n + c.width + 1, 0);
  const taskW = Math.max(8, cols - fixed);
  const width = (c: Col) => c.width || taskW;
  const head = [row(fit(paint(4, shown.map(c => cell(c.name, width(c))).join(" ")), cols))];
  const rows: Row[] = [];
  for (const i of ctx.visible) {
    const on = i.id === selectedId;
    const parts = shown.map(c => { const [t, code] = c.get(i); const v = cell(clip(t, width(c)), width(c)); return on || code === undefined ? v : paint(code, v); });
    rows.push(row(on ? paint(7, cell(parts.join(" "), cols)) : fit(parts.join(" "), cols), i.id));
    if (on) {
      const reason = i.attention ? paint(31, `${i.attention.kind}: `) + clip(i.attention.reason, cols) : dimmed(clip(i.summary, cols));
      rows.push(row(fit(`  ${dimmed("╰")} ${reason}`, cols), i.id));
      rows.push(row(fit(`    ${track(i, ctx.frame, "─")}  ${i.pr ? prText(i) + " " + dimmed(i.pr.url) : dimmed("no PR yet")}  ${waits(i)}`, cols), i.id));
    }
  }
  if (!rows.length) rows.push(row(dimmed("No tasks.")));
  return { head, rows, order, selectedId, detail: "none", legend: dimmed("DEPS ✓n merged prerequisite · REV rN review rounds, ✓ validated") };
}

// H — Activity: most recently changed first, grouped by day, with what last happened.
function happened(i: Info): string {
  if (i.stage === 4) return `merged ${i.pr ? "PR #" + i.pr.number : ""}`;
  if (i.attention) return `${i.attention.kind}: ${i.attention.reason}`;
  if (i.task.status === "ready_to_merge") return "validated, ready to merge";
  if (i.stage === 3 && i.pr) return `PR #${i.pr.number} opened`;
  const run = i.task.runs.at(-1);
  if (run) return `${run.role} ${run.state}`;
  return i.waitsOn.length ? `waiting on ${i.waitsOn.map(d => "#" + d.number).join(", ")}` : "registered";
}
function activityFeed(ctx: Ctx): Layout {
  const now = Date.now(), day = 86400000;
  const sorted = [...ctx.visible].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
  const bucket = (i: Info) => { const age = now - Date.parse(i.updatedAt); return !(age >= 0) || age < day ? "Today" : age < 2 * day ? "Yesterday" : age < 7 * day ? "This week" : "Earlier"; };
  const order = sorted.map(i => i.id), selectedId = pick(order, ctx.requested);
  const rows: Row[] = [];
  let current = "";
  for (const i of sorted) {
    const b = bucket(i);
    if (b !== current) { if (rows.length) rows.push(row("")); rows.push(row(strong(dimmed(`── ${b} ${"─".repeat(Math.max(0, ctx.cols - b.length - 4))}`)))); current = b; }
    const on = i.id === selectedId, t = new Date(Date.parse(i.updatedAt));
    const clock = Number.isFinite(t.getTime()) ? t.toTimeString().slice(0, 5) : "--:--";
    const w = Math.max(10, Math.min(40, Math.floor(ctx.cols / 3)));
    const what = i.attention ? paint(31, clip(happened(i), w)) : dimmed(clip(happened(i), w));
    rows.push(row(spread(`${mark(on)} ${dimmed(clock)} ${live(i, ctx.frame) || dot(i) + " "}${title(i, on, ctx.cols)}`, `${what} ${dimmed(ago(i.updatedAt).padStart(3))}`, ctx.cols), i.id));
  }
  const selected = ctx.visible.find(i => i.id === selectedId);
  return { rows, order, selectedId, detail: "bottom", details: richDetails(selected, ctx.cols, ctx.frame), bodyShare: 0.5, legend: LEGEND };
}

export interface Variant { letter: string; name: string; idea: string; render: (ctx: Ctx) => Layout }
export const VARIANTS: Variant[] = [
  { letter: "A", name: "Lanes", idea: "grouped by what needs you: needs you / in flight / PR out / queued / merged; rich details below", render: lanes },
  { letter: "B", name: "Pipeline", idea: "each row is a worker → review → PR → merged track; details at the side when wide", render: pipeline },
  { letter: "C", name: "Board", idea: "kanban status columns with two-line cards; ← → between columns", render: board },
  { letter: "D", name: "Cards", idea: "two-line cards; the selected card expands in place", render: cards },
  { letter: "E", name: "Split", idea: "master list left, details + dependency mini-graph right", render: split },
  { letter: "F", name: "Tree", idea: "dependency tree with ├─ └─ connectors, folding and +#n extra prerequisites", render: tree },
  { letter: "G", name: "Table", idea: "gh-style columns (status, PR, deps, review), a peek opens under the selected row", render: table },
  { letter: "H", name: "Activity", idea: "most recently changed first, grouped by day, with what last happened", render: activityFeed },
];
