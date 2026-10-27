import { taskTreeView, type Task, type TaskTreeView } from "../../protocol/tasks";
import { cells, plainText, visibleLength, wordWrap } from "./text";

export interface TaskTreeOptions {
  cols: number; rows: number; selectedId?: string;
  /** Independent graph cell offsets and metadata line offset; caller owns scrolling. */
  graphX?: number; graphY?: number; detailY?: number;
}
export interface TaskTreeHit { id: string; number: number; row: number; col: number; width: number }
/** Coordinates/offsets are zero-based terminal cells, not JS string indices. */
export interface TaskTreeRender {
  lines: string[]; hits: TaskTreeHit[]; selectedId?: string; order: string[]; errors: string[];
  graph: { width: number; height: number; x: number; y: number; rows: number; cols: number };
  details: { height: number; y: number; rows: number };
}
const size = (n: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1;
const offset = (n: number | undefined, max: number) => Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n!))) : 0;
const text = (v: unknown) => plainText(String(v ?? "unknown"));
const glyph: Record<number, string> = { 1: "│", 2: "─", 4: "│", 8: "─", 5: "│", 10: "─", 3: "└", 6: "┌", 9: "┘", 12: "┐", 7: "├", 11: "┴", 13: "┤", 14: "┬", 15: "┼" };

/** Dormant, no I/O. Requires the complete registry, including archived prerequisites.
 * Each identity owns a column; each edge owns a routing row. ╪ is a crossing,
 * NOT a junction. Bounded sparse viewport avoids allocating a whole graph canvas.
 * Limits reject explicitly, never silently prune dependencies or duplicate nodes.
 */
export function renderTaskTree(input: readonly (Task | TaskTreeView)[], options: TaskTreeOptions): TaskTreeRender {
  const cols = size(options.cols, 500), rows = size(options.rows, 200), errors: string[] = [];
  let tasks: TaskTreeView[] = [];
  try {
    if (input.length > 256) throw new Error("Graph limit: 256 tasks; filter only with complete prerequisites");
    tasks = input.map(t => taskTreeView("source" in t ? t.source : t));
    tasks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } catch (e) { errors.push(text(e instanceof Error ? e.message : e)); }
  const byId = new Map(tasks.map(t => [t.id.toLowerCase(), t]));
  if (byId.size !== tasks.length) errors.push("Duplicate task identity");
  const index = new Map(tasks.map((t, i) => [t.id.toLowerCase(), i]));
  const parents = tasks.map(t => t.dependsOn.map(id => index.get(id.toLowerCase()) ?? -1));
  if (parents.some(p => p.includes(-1))) errors.push("Dangling prerequisite: complete registry required");
  if (parents.reduce((n, p) => n + p.length, 0) > 1024) errors.push("Graph limit: 1024 dependencies");
  const pending = new Set(tasks.map((_, i) => i)), layers: number[][] = [];
  while (!errors.length && pending.size) {
    const next = [...pending].filter(i => parents[i]!.every(p => !pending.has(p)));
    if (!next.length) { errors.push("Dependency cycle: no valid layout"); break; }
    next.forEach(i => pending.delete(i)); layers.push(next);
  }
  const selected = tasks.find(t => t.id === options.selectedId) ?? tasks[0];
  const labels = tasks.map((t, i) => `${t.id === selected?.id ? "▶" : " "}[${i + 1}] ${text(t.name)}`);
  const wide = cols >= 90, graphCols = wide ? Math.floor(cols * .55) : cols;
  const lane = Math.max(10, Math.min(28, Math.floor(graphCols / Math.max(1, tasks.length)))), xs = tasks.map((_, i) => i * lane + 2), ys: number[] = [];
  const edges: { from: number; to: number; y: number }[] = [];
  let height = 0;
  for (const layer of layers) {
    layer.forEach(i => ys[i] = height); height++;
    for (const i of layer) tasks.forEach((_, j) => { if (parents[j]!.includes(i)) edges.push({ from: i, to: j, y: height++ }); });
    height++;
  }
  const graphRows = Math.max(1, wide ? rows - 2 : Math.floor((rows - 2) / 2));
  const detailRows = Math.max(0, wide ? rows - 2 : rows - graphRows - 2);
  const detailCols = wide ? cols - graphCols - 3 : cols;
  const width = Math.max(1, tasks.length * lane), gx = offset(options.graphX, Math.max(0, width - graphCols));
  const gy = offset(options.graphY, Math.max(0, height - graphRows));
  const masks = Array.from({ length: graphRows }, () => Array<number>(graphCols).fill(0));
  const junctions = new Set<string>();
  const mark = (x: number, y: number, mask: number) => {
    if (x >= gx && x < gx + graphCols && y >= gy && y < gy + graphRows) masks[y - gy]![x - gx]! |= mask;
  };
  const segment = (x: number, y: number, u: number, v: number) => {
    const dx = Math.sign(u - x), dy = Math.sign(v - y);
    // Iteration bounded by the viewport, even when endpoints are offscreen.
    if (dx) for (let c = Math.max(Math.min(x, u), gx); c <= Math.min(Math.max(x, u), gx + graphCols - 1); c++) mark(c, y, (c > Math.min(x, u) ? 8 : 0) | (c < Math.max(x, u) ? 2 : 0));
    if (dy) for (let r = Math.max(Math.min(y, v), gy); r <= Math.min(Math.max(y, v), gy + graphRows - 1); r++) mark(x, r, (r > Math.min(y, v) ? 1 : 0) | (r < Math.max(y, v) ? 4 : 0));
  };
  if (!errors.length) for (const e of edges) {
    const x = xs[e.from]!, u = xs[e.to]!;
    segment(x, ys[e.from]! + 1, x, e.y);
    segment(x, e.y, u, e.y); segment(u, e.y, u, ys[e.to]! - 1);
    mark(x, ys[e.from]! + 1, 1); mark(u, ys[e.to]! - 1, 4);
    junctions.add(`${x},${e.y}`); junctions.add(`${u},${e.y}`);
  }
  const canvas = masks.map((row, y) => row.map((m, x) => m === 15 && !junctions.has(`${x + gx},${y + gy}`) ? "╪" : glyph[m] ?? " "));
  const hits: TaskTreeHit[] = [];
  if (!errors.length) tasks.forEach((t, i) => {
    const row = ys[i]! - gy;
    if (row < 0 || row >= graphRows) return;
    let x = i * lane;
    const shortened = visibleLength(labels[i]!) > lane - 1;
    let prefix = "";
    for (const c of cells(labels[i]!)) {
      if (visibleLength(prefix) + c.width > lane - 2) break;
      prefix += c.text;
    }
    const label = shortened ? prefix + "…" : labels[i]!;
    for (const c of cells(label)) {
      if (x + c.width > (i + 1) * lane - 1) break;
      if (c.width && x >= gx && x + c.width <= gx + graphCols) {
        canvas[row]![x - gx] = c.text;
        for (let k = 1; k < c.width; k++) canvas[row]![x - gx + k] = "";
        hits.push({ id: t.id, number: i + 1, row: row + 1, col: x - gx, width: c.width });
      }
      x += c.width;
    }
  });
  const detail: string[] = [];
  const field = (name: string, value: unknown) => detail.push(...wordWrap(`${name}: ${text(value)}`, Math.max(1, detailCols)));
  if (selected) {
    const s = selected.source;
    field(`SELECTED [${tasks.indexOf(selected) + 1}]`, s.name);
    field("Summary", s.summary); field("Branch", s.branch); field("Lifecycle", selected.state.kind);
    field("Attention", s.attention ? `${s.attention.kind}: ${s.attention.reason}` : "none");
    field("Dependencies", selected.dependsOn.length ? selected.dependsOn.map(id => {
      const i = index.get(id.toLowerCase()); return i === undefined ? `${id} (missing)` : `[${i + 1}] ${tasks[i]!.name} (${id})`;
    }).join(", ") : "none");
    field("PR", s.pr ? `${s.pr.repository} #${s.pr.number} ${s.pr.url} head ${s.pr.head}` : "not recorded");
    field("Readiness", s.readiness ? JSON.stringify(s.readiness) : "not recorded (not inferred)");
    field("Verified archive", s.archive ? JSON.stringify(s.archive) : "not recorded");
    field("Runs", s.runs.length ? JSON.stringify(s.runs) : "none recorded");
    field("ID", s.id); field("Created", s.createdAt); field("Updated", s.updatedAt); field("Revision", s.revision);
  } else field("Tasks", "No tasks");
  const dy = offset(options.detailY, Math.max(0, detail.length - detailRows));
  const graphLines = canvas.map(r => r.join(""));
  if (errors.length || !tasks.length) {
    graphLines.fill("");
    wordWrap(errors.length ? `ERROR: ${errors.join("; ")}` : "No tasks", graphCols).slice(0, graphRows).forEach((l, i) => graphLines[i] = l);
  }
  const lines = [wordWrap(`TASKS ↓ prerequisites → dependents; ╪ crossing, not join`, cols)[0]!];
  for (let r = 0; r < graphRows; r++) {
    const left = graphLines[r] ?? "";
    lines.push(wide ? left + " ".repeat(Math.max(0, graphCols - visibleLength(left))) + " │ " + (detail[dy + r] ?? "") : left);
  }
  if (!wide) lines.push(...detail.slice(dy, dy + detailRows));
  lines.push(wordWrap(`Graph x=${gx}/${Math.max(0, width - graphCols)} y=${gy}/${Math.max(0, height - graphRows)}; details=${dy}/${Math.max(0, detail.length - detailRows)}`, cols)[0]!);
  return { lines: lines.slice(0, rows), hits: hits.filter(h => h.row < rows), selectedId: selected?.id, order: tasks.map(t => t.id), errors,
    graph: { width, height, x: gx, y: gy, rows: graphRows, cols: graphCols }, details: { height: detail.length, y: dy, rows: detailRows } };
}
