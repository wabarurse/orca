import { taskPublicationMilestone } from "../../protocol/tasks";
import { check, type Task, type TaskTreeView } from "../../protocol/tasks";
import { cells, plainText, visibleLength, wordWrap, wrap } from "./text";
import { treeTasks, type TreeTask } from "./task-tree-data";

export interface TaskTreeOptions {
  cols: number; rows: number; selectedId?: string;
  /** Independent list offsets and details line offset; caller owns scrolling. */
  graphX?: number; graphY?: number; detailY?: number; revealSelected?: boolean;
  collapsed?: ReadonlySet<string>; frame?: number;
}
export interface TaskTreeHit { id: string; number: number; row: number; col: number; width: number }
/** Coordinates/offsets are zero-based terminal cells, not JS string indices. */
export interface TaskTreeRender {
  nodes: OutlineNode[]; animated: boolean;
  lines: string[]; hits: TaskTreeHit[]; selectedId?: string; order: string[]; errors: string[];
  graph: { width: number; height: number; x: number; y: number; rows: number; cols: number };
  details: { height: number; y: number; rows: number };
}
export interface OutlineNode { id: string; depth: number; parent?: string; children: string[] }
interface Viewport { x: number; y: number; rows: number; cols: number }
interface Panels { cols: number; rows: number; graphCols: number; graphRows: number; detailCols: number; detailRows: number }
const size = (n: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1;
const offset = (n: number | undefined, max: number) => Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n!))) : 0;
/** wordWrap alone permits a two-cell grapheme in a one-cell column. */
function safeLines(value: string, cols: number): string[] {
  const lines: string[] = [];
  for (const line of wordWrap(plainText(value), cols)) {
    for (const fitted of wrap(line, cols)) lines.push(fitted);
  }
  return lines;
}

/** Clip without wordWrap: leading spaces encode the filesystem hierarchy. */
function outlineLabel(label: string, cols: number): string {
  if (visibleLength(label) <= cols) return label;
  let result = "", width = 0;
  for (const cell of cells(label)) {
    if (width + cell.width > cols - 1) break;
    result += cell.text;
    width += cell.width;
  }
  return result + "…";
}

function panels(options: TaskTreeOptions): Panels {
  const cols = size(options.cols, 500), rows = size(options.rows, 200);
  const graphCols = cols, detailCols = cols;
  const graphRows = Math.max(1, Math.min(8, Math.floor((rows - 3) / 3)));
  const detailRows = Math.max(0, rows - graphRows - 3);
  return { cols, rows, graphCols, graphRows, detailCols, detailRows };
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

/** A single canonical identity, placed under its lowest-UUID prerequisite.
 * Other prerequisites remain explicit references, never implied tree edges.
 */
function outline(tasks: TreeTask[], collapsed: ReadonlySet<string>): OutlineNode[] {
  const { parents } = dependencyLayers(tasks);
  const primary = parents.map(ps => [...ps].sort((a, b) => a - b)[0]);
  const children = tasks.map((_, i) => tasks.flatMap((t, j) => primary[j] === i ? [t.id] : []));
  const result: OutlineNode[] = [];
  const visit = (i: number, depth: number) => {
    const task = tasks[i]!;
    result.push({ id: task.id, depth, parent: primary[i] === undefined ? undefined : tasks[primary[i]!]!.id, children: children[i]! });
    if (!collapsed.has(task.id)) for (let j = 0; j < tasks.length; j++) if (primary[j] === i) visit(j, depth + 1);
  };
  tasks.forEach((_, i) => { if (primary[i] === undefined) visit(i, 0); });
  return result;
}

function active(task: TreeTask): boolean {
  return !task.archive && !task.attention && task.runs.some(run => run.state === "started" && !run.endedAt);
}

function status(task: TreeTask): string {
  const milestone = taskPublicationMilestone(task);
  if (milestone.kind !== "unknown") return milestone.kind === "merged" ? "Merged" : milestone.label;
  if (task.attention) return task.attention.kind;
  if (active(task)) return "Loading";
  if (task.status === "ready_to_merge" && task.readiness?.head === task.pr?.head) return "Ready";
  const latest = task.runs.at(-1);
  if (latest?.state === "stopped" || latest?.state === "failed") return latest.state;
  return task.status.replaceAll("_", " ");
}

function statusColor(task: TreeTask): number {
  const tone = taskPublicationMilestone(task).tone;
  return tone === "purple" ? 35 : tone === "green" ? 32 : 90;
}

function activity(task: TreeTask): string {
  return task.runs.filter(run => run.state === "started" && !run.endedAt)
    .map(run => run.role === "worker" ? "working" : "reviewing").join(" / ");
}

export function navigateOutline(nodes: OutlineNode[], selectedId: string | undefined, collapsed: Set<string>, key: string, shift = false): string | undefined {
  const i = nodes.findIndex(node => node.id === selectedId), node = nodes[i];
  if (!node) return nodes[0]?.id;
  const previous = key === "up" || key === "left";
  if (shift) {
    for (let j = i + (previous ? -1 : 1); j >= 0 && j < nodes.length; j += previous ? -1 : 1) {
      if (nodes[j]!.depth === node.depth) return nodes[j]!.id;
    }
  } else if (key === "up" || key === "down") return nodes[i + (previous ? -1 : 1)]?.id ?? node.id;
  else if (key === "left") {
    if (node.children.length && !collapsed.has(node.id)) collapsed.add(node.id);
    else return node.parent ?? node.id;
  } else if (key === "right" && node.children.length) {
    if (collapsed.has(node.id)) collapsed.delete(node.id);
    else return node.children[0];
  }
  return node.id;
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

function detailFields(tasks: TreeTask[], selected: TreeTask): [string, string][] {
  const dependencies = selected.dependsOn.map(id => {
    const i = tasks.findIndex(t => t.id.toLowerCase() === id.toLowerCase());
    return `#${i + 1} ${tasks[i]!.name}`;
  });
  const fields: [string, string][] = [
    [`Task #${tasks.indexOf(selected) + 1} · ${status(selected)}`, selected.name],
    ["Overview", selected.summary],
    ["Dependencies", dependencies.join("; ") || "none"],
  ];
  if (active(selected)) fields.push(["Activity", activity(selected)]);
  const milestone = taskPublicationMilestone(selected);
  if ("observedAt" in milestone) fields.push(["Observed", `${milestone.observedAt} (historical; not merge permission)`]);
  if (selected.attention) fields.push(["Attention", `${selected.attention.kind}: ${selected.attention.reason}`]);
  const latest = selected.runs.at(-1);
  if (latest) fields.push(["Run", `${latest.role}: ${latest.state}`]);
  if (selected.readiness) fields.push(["Validation", `${selected.readiness.checks}: ${selected.readiness.validation}`]);
  return fields;
}

function detailLines(tasks: TreeTask[], selected: TreeTask | undefined, cols: number): string[] {
  if (!selected) return safeLines("Tasks: No tasks", cols);
  const lines: string[] = [];
  for (const [name, value] of detailFields(tasks, selected)) {
    lines.push(...safeLines(`${name}: ${value}`, cols), "");
  }
  const pr = selected.archive?.pr ?? selected.pr;
  if (pr) {
    for (const label of safeLines(`PR: ${pr.repository} #${pr.number}`, cols)) {
      lines.push(`\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07`);
    }
    lines.push(...safeLines(pr.url, cols));
  } else lines.push(...safeLines("PR: not recorded", cols));
  return lines;
}

function compose(p: Panels, graph: string[], detail: string[], detailY: number, footer: string): string[] {
  const lines = [safeLines("TASKS", p.cols)[0]!];
  for (let row = 0; row < p.graphRows; row++) lines.push(graph[row] ?? "");
  lines.push("");
  for (let row = 0; row < p.detailRows; row++) lines.push(detail[detailY + row] ?? "");
  lines.push(safeLines(footer, p.cols)[0]!);
  return lines.slice(0, p.rows);
}

function failed(p: Panels, error: unknown): TaskTreeRender {
  // Only renderer-generated, fixed error messages cross this boundary.
  const message = error instanceof Error ? error.message : "Invalid task registry";
  const errors = [plainText(message).slice(0, 256)];
  const lines = compose(p, safeLines(`ERROR: ${errors[0]}`, p.graphCols), [], 0, "Invalid registry; no outline rendered");
  return { nodes: [], animated: false, lines, errors, hits: [], order: [], graph: { width: 0, height: 0, x: 0, y: 0, rows: p.graphRows, cols: p.graphCols }, details: { height: 0, y: 0, rows: p.detailRows } };
}

/** Read-only complete registry, including archived prerequisites. Invalid graphs fail closed. */
export function renderTaskTree(input: readonly (Task | TaskTreeView)[], options: TaskTreeOptions): TaskTreeRender {
  const p = panels(options);
  try {
    const tasks = treeTasks(input), collapsed = options.collapsed ?? new Set<string>();
    const nodes = outline(tasks, collapsed);
    const selected = tasks.find(t => t.id === options.selectedId && nodes.some(n => n.id === t.id)) ?? tasks.find(t => t.id === nodes[0]?.id);
    const view = { cols: p.graphCols, rows: p.graphRows, x: 0,
      y: offset(options.graphY, Math.max(0, nodes.length - p.graphRows)) };
    if (options.revealSelected && selected) {
      const y = nodes.findIndex(n => n.id === selected.id);
      view.y = Math.max(y - view.rows + 1, Math.min(view.y, y));
    }
    const canvas = Array.from({ length: view.rows }, () => Array<string>(view.cols).fill(" "));
    const hits: TaskTreeHit[] = [];
    for (const [row, node] of nodes.slice(view.y, view.y + view.rows).entries()) {
      const i = tasks.findIndex(t => t.id === node.id), task = tasks[i]!;
      const indent = "  ".repeat(Math.min(node.depth, Math.max(0, Math.floor((view.cols - 25) / 2))));
      const label = `${node.id === selected?.id ? "▶" : " "}${indent}#${i + 1} ● ${plainText(task.name)}`;
      hits.push(...paintNode(canvas, outlineLabel(label, view.cols), 0, row, view, { id: task.id, number: i + 1 }));
    }
    const detail = detailLines(tasks, selected, p.detailCols);
    const dy = offset(options.detailY, Math.max(0, detail.length - p.detailRows));
    const lines = canvas.map((row, i) => {
      const task = tasks.find(t => t.id === nodes[view.y + i]?.id);
      const line = row.join("");
      return task ? line.replace("●", `\x1b[${statusColor(task)}m●\x1b[0m`) : line;
    });
    if (!tasks.length) lines[0] = "No tasks";
    const footer = `Outline y=${view.y}/${Math.max(0, nodes.length - view.rows)}; details=${dy}/${Math.max(0, detail.length - p.detailRows)}`;
    return { nodes, animated: nodes.slice(view.y, view.y + view.rows).some(n => active(tasks.find(t => t.id === n.id)!)),
      lines: compose(p, lines, detail, dy, footer), hits, selectedId: selected?.id,
      order: nodes.map(n => n.id), errors: [], graph: { ...view, width: view.cols, height: nodes.length },
      details: { height: detail.length, y: dy, rows: p.detailRows } };
  } catch (error) { return failed(p, error); }
}
