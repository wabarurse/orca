// MOCKUP-PICK (throwaway): mounts the task-list variants inside the real Ctrl+T overlay.
// 0 = today's renderer, 1–8 = variants A–H, `v` cycles. Deleted after the pick.
import type { Task, TaskTreeView } from "../../protocol/task";
import type { Key } from "./keys";
import { navigateOutline, outline, renderTaskTree, type OutlineNode, type TaskTreeHit, type TaskTreeOptions, type TaskTreeRender } from "./task-tree";
import { treeTasks } from "./task-tree-data";
import { cell, dimmed, infos, paint, type Layout } from "./task-tree-mockup-kit";
import { VARIANTS } from "./task-tree-variants";
import { fit } from "./text";

export { VARIANTS };
export interface VariantRender extends TaskTreeRender { mockup: { detail: Layout["detail"]; columns?: string[][]; outline: boolean } }
export interface MockupView {
  variant?: number; selectedId?: string; graphY: number; detailY: number;
  collapsed: Set<string>; revealSelected?: boolean; detailsFocused?: boolean;
}
/** Remembered across overlay opens in this process; starts on A. */
let last = 1;

function header(variant: number, cols: number): string {
  const pills = ["0", ...VARIANTS.map(v => v.letter)].map((l, k) => k === variant ? paint(7, ` ${l} `) : dimmed(` ${l} `)).join("");
  const v = VARIANTS[variant - 1];
  const name = v ? `${paint(1, `${v.letter} · ${v.name}`)} ${dimmed("— " + v.idea)}` : `${paint(1, "0 · Current")} ${dimmed("— today's outline")}`;
  return fit(`${paint(1, "TASKS")} ${pills}  ${name}`, cols);
}

export function renderTaskTreeVariant(input: readonly (Task | TaskTreeView)[], options: TaskTreeOptions & { variant?: number }): TaskTreeRender {
  const variant = options.variant ?? last;
  const cols = Math.max(1, Math.min(500, Math.floor(options.cols) || 1)), total = Math.max(1, Math.min(200, Math.floor(options.rows) || 1));
  if (!VARIANTS[variant - 1]) {
    const base = renderTaskTree(input, options);
    return { ...base, lines: [header(0, cols), ...base.lines.slice(1)] };
  }
  let tasks, nodes: OutlineNode[];
  try { tasks = treeTasks(input); nodes = outline(tasks, options.collapsed ?? new Set()); }
  catch { const base = renderTaskTree(input, options); return { ...base, lines: [header(variant, cols), ...base.lines.slice(1)] }; }
  const { all, visible } = infos(tasks, nodes);
  const layout = VARIANTS[variant - 1]!.render({ all, visible, outline: nodes, cols, rows: total, frame: options.frame ?? 0,
    requested: options.selectedId, collapsed: options.collapsed ?? new Set() });
  if (!layout.rows.length) layout.rows.push({ text: dimmed("  No tasks yet — the orchestrator registers them as work is dispatched.") });

  const head = layout.head ?? [], side = layout.detail === "side" && layout.order.length ? layout.sideCols ?? 0 : 0;
  const leftCols = side ? cols - side - 3 : cols;
  const avail = Math.max(1, total - 2 - (side ? 0 : head.length));
  let bodyRows = avail, detailRows = 0;
  if (layout.detail === "bottom" && avail >= 5 && layout.order.length) {
    bodyRows = Math.max(2, Math.floor((avail - 1) * (layout.bodyShare ?? 0.5)));
    if (layout.rows.length < bodyRows) bodyRows = Math.max(1, layout.rows.length);
    detailRows = avail - 1 - bodyRows;
  }
  if (side) bodyRows = Math.max(1, avail - head.length);
  // Scroll the body: keep the selected row range visible (its first row wins when it is taller than the window).
  let y = Math.max(0, Math.min(options.graphY ?? 0, layout.rows.length - bodyRows));
  if (options.revealSelected && layout.selectedId) {
    const first = layout.rows.findIndex(r => r.ids?.some(h => h.id === layout.selectedId));
    let lastRow = first;
    while (layout.rows[lastRow + 1]?.ids?.some(h => h.id === layout.selectedId)) lastRow++;
    if (first >= 0) { if (lastRow >= y + bodyRows) y = lastRow - bodyRows + 1; if (first < y) y = first; }
  }
  const details = layout.details ?? [];
  const panelRows = side ? avail : detailRows;
  const dy = Math.max(0, Math.min(options.detailY ?? 0, details.length - panelRows));

  const lines: string[] = [header(variant, cols)];
  const hits: TaskTreeHit[] = [];
  const left: { text: string; ids?: { id: string; col: number; width: number }[] }[] = [...head, ...layout.rows.slice(y, y + bodyRows)];
  const leftHeight = side ? avail : head.length + bodyRows;
  for (let r = 0; r < leftHeight; r++) {
    const item = left[r], line = lines.length;
    for (const h of r >= head.length ? item?.ids ?? [] : []) {
      const width = Math.min(h.width, leftCols - h.col);
      if (width > 0) hits.push({ id: h.id, number: visible.find(i => i.id === h.id)?.number ?? 0, row: line, col: h.col, width });
    }
    const text = item?.text ?? "";
    lines.push(side ? `${cell(text, leftCols)} ${dimmed("│")} ${fit(details[dy + r] ?? "", side)}` : fit(text, cols));
  }
  if (detailRows > 0) {
    const more = details.length > detailRows ? dimmed(` ${dy + 1}–${Math.min(details.length, dy + detailRows)}/${details.length} PgUp/PgDn `) : "";
    lines.push(fit(dimmed("─".repeat(Math.max(0, cols - Bun.stringWidth(Bun.stripANSI(more))))) + more, cols));
    for (let r = 0; r < detailRows; r++) lines.push(fit(details[dy + r] ?? "", cols));
  }
  while (lines.length < total - 1) lines.push("");
  const scroll = layout.rows.length > bodyRows ? dimmed(`  ↕ ${y + 1}–${Math.min(layout.rows.length, y + bodyRows)}/${layout.rows.length}`) : "";
  lines.push(fit(`${layout.legend ?? ""}${scroll}`, cols));
  const flat = layout.order.map(id => ({ id, depth: 0, children: [] }));
  return {
    nodes: layout.nodes ?? flat, animated: visible.some(i => i.active), lines: lines.slice(0, total), hits,
    selectedId: layout.selectedId, order: layout.order, errors: [],
    graph: { width: leftCols, height: layout.rows.length, x: 0, y, rows: bodyRows, cols: leftCols },
    details: { height: details.length, y: dy, rows: panelRows },
    mockup: { detail: layout.detail, columns: layout.columns, outline: !!layout.nodes },
  } as VariantRender;
}

/** 0–8 pick a variant, `v` cycles. True when the key was taken. */
export function variantSwitch(view: MockupView, k: Key): boolean {
  if (k.name !== "char" || k.ctrl || k.alt) return false;
  if (k.text === "v" || k.text === "V") view.variant = ((view.variant ?? last) + (k.text === "v" ? 1 : VARIANTS.length)) % (VARIANTS.length + 1);
  else if (k.text && /^[0-8]$/.test(k.text)) view.variant = Number(k.text);
  else return false;
  last = view.variant;
  view.graphY = 0; view.detailY = 0; view.revealSelected = true; view.detailsFocused = false;
  return true;
}

/** Variant navigation; false hands the key to today's outline handling (variant 0). */
export function variantNavigate(view: MockupView, rendered: TaskTreeRender, k: Key): boolean {
  if (!("mockup" in rendered)) return false;
  const m = (rendered as VariantRender).mockup, order = rendered.order, at = order.indexOf(view.selectedId ?? "");
  const select = (id: string | undefined) => { if (id && id !== view.selectedId) { view.selectedId = id; view.detailY = 0; } view.revealSelected = true; };
  const col = m.columns?.findIndex(c => c.includes(view.selectedId ?? "")) ?? -1;
  if (k.name === "up" || k.name === "down") {
    if (m.columns && col >= 0) {
      const c = m.columns[col]!, i = c.indexOf(view.selectedId!);
      select(c[Math.max(0, Math.min(c.length - 1, i + (k.name === "up" ? -1 : 1)))]);
    } else select(order[Math.max(0, Math.min(order.length - 1, at + (k.name === "up" ? -1 : 1)))]);
  } else if (k.name === "home" || k.name === "end") select(k.name === "home" ? order[0] : order.at(-1));
  else if (k.name === "left" || k.name === "right") {
    if (m.columns && col >= 0) {
      const step = k.name === "left" ? -1 : 1, i = m.columns[col]!.indexOf(view.selectedId!);
      for (let c = col + step; c >= 0 && c < m.columns.length; c += step) {
        const target = m.columns[c]!;
        if (target.length) { select(target[Math.min(i, target.length - 1)]); break; }
      }
    } else if (m.outline) select(navigateOutline(rendered.nodes, view.selectedId, view.collapsed, k.name));
  } else if (k.name === "pageup" || k.name === "pagedown") {
    const sign = k.name === "pageup" ? -1 : 1;
    // In-place details: a page moves the selection by about a screenful of items, so it stays in view.
    if (m.detail === "none") select(order[Math.max(0, Math.min(order.length - 1, at + sign * Math.max(1, Math.floor(rendered.graph.rows / Math.max(1, rendered.graph.height / Math.max(1, order.length))) - 1)))]);
    else view.detailY += sign * Math.max(1, rendered.details.rows - 1);
  } else if (k.name === "wheelup" || k.name === "wheeldown") view.graphY += k.name === "wheelup" ? -1 : 1;
  else return false;
  return true;
}
