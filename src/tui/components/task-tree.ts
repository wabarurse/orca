import { check, type Task, type TaskTreeView } from "../../protocol/tasks";
import { cells, plainText, visibleLength, wordWrap, wrap } from "./text";
import { treeTasks, type TreeTask } from "./task-tree-data";

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
interface Edge { from: number; to: number; y: number }
interface Layout { lane: number; ys: number[]; edges: Edge[]; width: number; height: number }
interface Viewport { x: number; y: number; rows: number; cols: number }
interface Panels { cols: number; rows: number; wide: boolean; graphCols: number; graphRows: number; detailCols: number; detailRows: number }
const size = (n: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1;
const offset = (n: number | undefined, max: number) => Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n!))) : 0;
const glyph: Record<number, string> = { 1: "│", 2: "─", 4: "│", 8: "─", 5: "│", 10: "─", 3: "└", 6: "┌", 9: "┘", 12: "┐", 7: "├", 11: "┴", 13: "┤", 14: "┬", 15: "┼" };

/** wordWrap alone permits a two-cell grapheme in a one-cell column. */
function safeLines(value: string, cols: number): string[] {
  const lines: string[] = [];
  for (const line of wordWrap(plainText(value), cols)) {
    for (const fitted of wrap(line, cols)) lines.push(fitted);
  }
  return lines;
}

function panels(options: TaskTreeOptions): Panels {
  const cols = size(options.cols, 500), rows = size(options.rows, 200);
  const wide = cols >= 90;
  const graphCols = wide ? Math.floor(cols * .55) : cols;
  const graphRows = Math.max(1, wide ? rows - 2 : Math.floor((rows - 2) / 2));
  const detailRows = Math.max(0, wide ? rows - 2 : rows - graphRows - 2);
  const detailCols = wide ? cols - graphCols - 3 : cols;
  return { cols, rows, wide, graphCols, graphRows, detailCols, detailRows };
}

function dependencyLayers(tasks: TreeTask[]): { layers: number[][]; parents: number[][] } {
  const index = new Map(tasks.map((t, i) => [t.id.toLowerCase(), i]));
  check(index.size === tasks.length, "Duplicate task identity");
  const parents = tasks.map(t => t.dependsOn.map(id => index.get(id.toLowerCase()) ?? -1));
  check(!parents.some(p => p.includes(-1)), "Dangling prerequisite: complete registry required");
  const pending = new Set(tasks.map((_, i) => i));
  const layers: number[][] = [];
  while (pending.size) {
    const next = [...pending].filter(i => parents[i]!.every(p => !pending.has(p)));
    check(next.length, "Dependency cycle: no valid layout");
    for (const i of next) pending.delete(i);
    layers.push(next);
  }
  return { layers, parents };
}

function layout(tasks: TreeTask[], cols: number): Layout {
  const { layers, parents } = dependencyLayers(tasks);
  const lane = Math.max(10, Math.min(28, Math.floor(cols / Math.max(1, tasks.length))));
  const ys: number[] = [], edges: Edge[] = [];
  let height = 0;
  for (const layer of layers) {
    for (const i of layer) ys[i] = height;
    height++;
    for (const i of layer) {
      for (let j = 0; j < tasks.length; j++) {
        if (parents[j]!.includes(i)) edges.push({ from: i, to: j, y: height++ });
      }
    }
    height++;
  }
  return { lane, ys, edges, width: Math.max(1, tasks.length * lane), height };
}

/** Sparse viewport raster: routes visit visible cells only, not their full lengths. */
class Routes {
  private masks: number[][];
  private junctions = new Set<string>();
  constructor(private view: Viewport) {
    this.masks = Array.from({ length: view.rows }, () => Array<number>(view.cols).fill(0));
  }
  private mark(x: number, y: number, mask: number): void {
    const col = x - this.view.x, row = y - this.view.y;
    if (col < 0 || col >= this.view.cols || row < 0 || row >= this.view.rows) return;
    this.masks[row]![col]! |= mask;
  }
  private horizontal(x: number, u: number, y: number): void {
    const low = Math.min(x, u), high = Math.max(x, u);
    const end = Math.min(high, this.view.x + this.view.cols - 1);
    for (let col = Math.max(low, this.view.x); col <= end; col++) {
      let mask = 0;
      if (col > low) mask |= 8;
      if (col < high) mask |= 2;
      this.mark(col, y, mask);
    }
  }
  private vertical(x: number, y: number, v: number): void {
    const low = Math.min(y, v), high = Math.max(y, v);
    const end = Math.min(high, this.view.y + this.view.rows - 1);
    for (let row = Math.max(low, this.view.y); row <= end; row++) {
      let mask = 0;
      if (row > low) mask |= 1;
      if (row < high) mask |= 4;
      this.mark(x, row, mask);
    }
  }
  edge(edge: Edge, graph: Layout): void {
    const x = edge.from * graph.lane + 2, u = edge.to * graph.lane + 2;
    const start = graph.ys[edge.from]! + 1, end = graph.ys[edge.to]! - 1;
    this.vertical(x, start, edge.y);
    this.horizontal(x, u, edge.y);
    this.vertical(u, edge.y, end);
    this.mark(x, start, 1);
    this.mark(u, end, 4);
    this.junctions.add(`${x},${edge.y}`);
    this.junctions.add(`${u},${edge.y}`);
  }
  canvas(): string[][] {
    return this.masks.map((row, y) => row.map((mask, x) => {
      if (mask === 15 && !this.junctions.has(`${x + this.view.x},${y + this.view.y}`)) return "╪";
      return glyph[mask] ?? " ";
    }));
  }
}

function nodeLabel(task: TreeTask, number: number, selectedId: string | undefined, width: number): string {
  const focus = task.id === selectedId ? "▶" : " ";
  const label = `${focus}[${number}] ${plainText(task.name)}`;
  if (visibleLength(label) <= width) return label;
  let prefix = "", used = 0;
  for (const cell of cells(label)) {
    if (used + cell.width > width - 1) break;
    prefix += cell.text;
    used += cell.width;
  }
  return prefix + "…";
}

function paintNode(canvas: string[][], label: string, x: number, row: number, view: Viewport, identity: { id: string; number: number }): TaskTreeHit[] {
  const hits: TaskTreeHit[] = [];
  if (row < 0 || row >= view.rows) return hits;
  for (const cell of cells(label)) {
    const col = x - view.x;
    if (cell.width && col >= 0 && col + cell.width <= view.cols) {
      canvas[row]![col] = cell.text;
      for (let k = 1; k < cell.width; k++) canvas[row]![col + k] = "";
      hits.push({ ...identity, row: row + 1, col, width: cell.width });
    }
    x += cell.width;
  }
  return hits;
}

function graphLines(tasks: TreeTask[], selectedId: string | undefined, graph: Layout, view: Viewport): { lines: string[]; hits: TaskTreeHit[] } {
  const routes = new Routes(view);
  for (const edge of graph.edges) routes.edge(edge, graph);
  const canvas = routes.canvas(), hits: TaskTreeHit[] = [];
  for (const [i, task] of tasks.entries()) {
    const label = nodeLabel(task, i + 1, selectedId, graph.lane - 1);
    const nodeHits = paintNode(canvas, label, i * graph.lane, graph.ys[i]! - view.y, view, { id: task.id, number: i + 1 });
    for (const hit of nodeHits) hits.push(hit);
  }
  return { lines: canvas.map(row => row.join("")), hits };
}

function detailFields(tasks: TreeTask[], selected: TreeTask): [string, string][] {
  const index = new Map(tasks.map((t, i) => [t.id.toLowerCase(), i]));
  const dependencies = selected.dependsOn.map(id => {
    const i = index.get(id.toLowerCase())!;
    return `[${i + 1}] ${tasks[i]!.name} (${id})`;
  });
  const fields: [string, string][] = [
    [`SELECTED [${tasks.indexOf(selected) + 1}]`, selected.name],
    ["Summary", selected.summary], ["Branch", selected.branch],
    ["Lifecycle", selected.archive ? "merged" : selected.status],
    ["Attention", selected.attention ? `${selected.attention.kind}: ${selected.attention.reason}` : "none"],
    ["Dependencies", dependencies.join(", ") || "none"],
  ];
  const pr = selected.pr;
  fields.push(["PR", pr ? `${pr.repository} #${pr.number} ${pr.url} head ${pr.head}` : "not recorded"]);
  fields.push(["Readiness", selected.readiness ? JSON.stringify(selected.readiness) : "not recorded (not inferred)"]);
  fields.push(["Verified archive", selected.archive ? JSON.stringify(selected.archive) : "not recorded"]);
  fields.push(["Runs", selected.runs.length ? JSON.stringify(selected.runs) : "none recorded"]);
  fields.push(["ID", selected.id], ["Created", selected.createdAt], ["Updated", selected.updatedAt], ["Revision", String(selected.revision)]);
  return fields;
}

function detailLines(tasks: TreeTask[], selected: TreeTask | undefined, cols: number): string[] {
  if (!selected) return safeLines("Tasks: No tasks", cols);
  // Source strings were already bounded before JSON serialization. Bound derived
  // text too, before segmentation/wrapping; escape expansion never drops evidence.
  const fields = detailFields(tasks, selected);
  const length = fields.reduce((total, [name, value]) => total + name.length + value.length + 2, 0);
  check(length <= 65536, "Metadata limit: 65536 units of derived selected details");
  const lines: string[] = [];
  for (const [name, value] of fields) {
    for (const line of safeLines(`${name}: ${value}`, cols)) lines.push(line);
  }
  return lines;
}

function compose(p: Panels, graph: string[], detail: string[], detailY: number, footer: string): string[] {
  const lines = [safeLines("TASKS ↓ prerequisites → dependents; ╪ crossing, not join", p.cols)[0]!];
  for (let row = 0; row < p.graphRows; row++) {
    const left = graph[row] ?? "";
    if (p.wide) {
      const padding = " ".repeat(Math.max(0, p.graphCols - visibleLength(left)));
      lines.push(left + padding + " │ " + (detail[detailY + row] ?? ""));
    } else lines.push(left);
  }
  if (!p.wide) {
    for (const line of detail.slice(detailY, detailY + p.detailRows)) lines.push(line);
  }
  lines.push(safeLines(footer, p.cols)[0]!);
  return lines.slice(0, p.rows);
}

function failed(p: Panels, error: unknown): TaskTreeRender {
  // Only renderer-generated, fixed error messages cross this boundary.
  const message = error instanceof Error ? error.message : "Invalid task registry";
  const errors = [plainText(message).slice(0, 256)];
  const lines = compose(p, safeLines(`ERROR: ${errors[0]}`, p.graphCols), [], 0, "Invalid registry; no graph rendered");
  return { lines, errors, hits: [], order: [], graph: { width: 0, height: 0, x: 0, y: 0, rows: p.graphRows, cols: p.graphCols }, details: { height: 0, y: 0, rows: p.detailRows } };
}

/** Dormant, no I/O; requires the complete registry including archived prerequisites.
 * One identity/column, one edge/routing row; ╪ crosses without joining.
 * See treeTasks for source budgets. Derived selected details have a 65536-unit
 * budget; any malformed/over-budget record rejects the whole render, with no hits.
 * History/unknown properties are never cloned, traversed or serialized.
 */
export function renderTaskTree(input: readonly (Task | TaskTreeView)[], options: TaskTreeOptions): TaskTreeRender {
  const p = panels(options);
  try {
    const tasks = treeTasks(input), graph = layout(tasks, p.graphCols);
    const selected = tasks.find(t => t.id === options.selectedId) ?? tasks[0];
    const view = { cols: p.graphCols, rows: p.graphRows,
      x: offset(options.graphX, Math.max(0, graph.width - p.graphCols)),
      y: offset(options.graphY, Math.max(0, graph.height - p.graphRows)),
    };
    const detail = detailLines(tasks, selected, p.detailCols);
    const dy = offset(options.detailY, Math.max(0, detail.length - p.detailRows));
    const painted = graphLines(tasks, selected?.id, graph, view);
    if (!tasks.length) painted.lines = safeLines("No tasks", p.graphCols);
    const footer = `Graph x=${view.x}/${Math.max(0, graph.width - view.cols)} y=${view.y}/${Math.max(0, graph.height - view.rows)}; details=${dy}/${Math.max(0, detail.length - p.detailRows)}`;
    return { lines: compose(p, painted.lines, detail, dy, footer), hits: painted.hits.filter(h => h.row < p.rows),
      selectedId: selected?.id, order: tasks.map(t => t.id), errors: [],
      graph: { ...view, width: graph.width, height: graph.height }, details: { height: detail.length, y: dy, rows: p.detailRows },
    };
  } catch (error) {
    return failed(p, error);
  }
}
