import { publicTaskStatus } from "../../protocol/task";
import { taskPublicationMilestone } from "../../protocol/task";
import { check, taskStatusLabels, type Task, type TaskTreeView } from "../../protocol/task";
import { cells, fit, plainText, visibleLength, wordWrap, wrap } from "./text";
import { treeTasks, type TreeTask } from "./task-tree-data";

export interface TaskTreeOptions {
  cols: number; rows: number; selectedId?: string;
  /** Independent list and details line offsets; caller owns scrolling. */
  graphY?: number; detailY?: number; revealSelected?: boolean;
  collapsed?: ReadonlySet<string>; frame?: number;
}
export interface TaskTreeHit { id: string; number: number; row: number; col: number; width: number }
/** Coordinates/offsets are zero-based terminal cells, not JS string indices. */
export interface TaskTreeRender {
  nodes: OutlineNode[]; animated: boolean;
  lines: string[]; hits: TaskTreeHit[]; selectedId?: string; order: string[]; errors: string[];
  /** `x`/`width` are kept for the caller's bookkeeping; rows are clipped to `cols`, never scrolled sideways. */
  graph: { width: number; height: number; x: number; y: number; rows: number; cols: number };
  details: { height: number; y: number; rows: number };
}
export interface OutlineNode { id: string; depth: number; parent?: string; children: string[] }
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

/** The tree is the main panel: ~60% of the rows, shrunk to its node count; details take the rest (title, blank, footer = 3). */
function panels(options: TaskTreeOptions, nodeCount = Infinity): Panels {
  const cols = size(options.cols, 500), rows = size(options.rows, 200);
  const graphCols = cols, detailCols = cols;
  const graphRows = Math.max(1, Math.min(Math.max(1, nodeCount), Math.floor((rows - 3) * 0.6)));
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
  dependencyLayers(tasks); // Validate against retained SQL records before hiding membership.
  const visible = new Set(tasks.filter(t => !t.removedAt).map(t => t.id.toLowerCase()));
  tasks = tasks.filter(t => visible.has(t.id.toLowerCase())).map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => visible.has(id.toLowerCase())) }));
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

function status(task: TreeTask): string { return publicTaskStatus(task); }

/** Dot colour: merged purple, verified PR out green, stopped (blocked/cancelled/closed) red,
 * unknown yellow, building/working/reviewing/ready cyan, queued grey. A routine `waiting`
 * attention never hides progress. The PR milestone stays green even when blocked. */
function statusColor(task: TreeTask): number {
  const milestone = taskPublicationMilestone(task);
  if (milestone.kind === "merged") return 35;
  if (milestone.kind === "published") return 32;
  const kind = task.attention?.kind;
  if (kind === "blocked" || kind === "cancelled" || kind === "closed") return 31;
  if (kind === "unknown") return 33;
  if (active(task) || status(task) === "building" || task.status !== "queued") return 36;
  return 90;
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

const paint = (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s: string) => paint(2, s);
const SPINNER = ["◐", "◓", "◑", "◒"];
/** The status dot; an active task's dot spins with the caller's frame. */
function dot(task: TreeTask, frame: number): string {
  return paint(statusColor(task), active(task) ? SPINNER[frame % 4]! : "●");
}

/** One plain label, the inbox rule: attention first, then merged / ready / PR / lifecycle. */
function rowLabel(task: TreeTask): string {
  if (task.archive) return "merged";
  if (task.attention) return task.attention.kind;
  if (task.status === "ready_to_merge") return "ready to merge";
  const milestone = taskPublicationMilestone(task);
  if (milestone.kind === "published") return "PR open";
  if (milestone.kind === "closed") return "PR closed";
  return status(task) === "building" ? "building" : taskStatusLabels[task.status];
}

/** worker → review → PR → merged: 0 nothing yet, 4 merged. */
function stage(task: TreeTask): number {
  if (task.archive) return 4;
  if (task.pr || task.status === "ready_to_merge" || taskPublicationMilestone(task).kind !== "unknown") return 3;
  if (task.status === "reviewing" || task.runs.some(run => run.role === "reviewer")) return 2;
  if (task.status === "working" || task.runs.some(run => run.role === "worker")) return 1;
  return 0;
}

/** The pipeline as glyphs: ● done, ◉ here in the dot's colour (spinning while active, ✕ when stopped), ○ not yet. */
function track(task: TreeTask, frame: number): string {
  const at = stage(task), kind = task.attention?.kind;
  const stopped = kind === "blocked" || kind === "cancelled" || kind === "closed" || kind === "unknown";
  const doneColor = at === 4 ? 35 : 36; // progress cyan; green is reserved for a verified open PR
  const glyphs: string[] = [];
  for (let step = 1; step <= 4; step++) {
    const done = step < at || at === 4, here = step === at || (step === 1 && at === 0);
    const glyph = done ? paint(doneColor, "●") : here ? (stopped ? paint(31, "✕") : at === 0 ? paint(90, "○") : active(task) ? paint(36, SPINNER[frame % 4]!) : paint(statusColor(task), "◉")) : dim("○");
    glyphs.push((step > 1 ? (step <= Math.max(1, at) || at === 4 ? paint(doneColor, "──") : dim("┄┄")) : "") + glyph);
  }
  return glyphs.join("");
}

/** Clip an untrusted field to `cols` cells, grapheme-safe. */
function clip(text: string, cols: number): string {
  if (visibleLength(text) <= cols) return text;
  if (cols <= 1) return cols === 1 ? "…" : "";
  let result = "", width = 0;
  for (const cell of cells(text)) { if (width + cell.width > cols - 1) break; result += cell.text; width += cell.width; }
  return result + "…";
}

/** `left` clipped first, `right` kept whole at the row's end; `right` alone is dropped when it cannot fit. */
function spread(left: string, right: string, cols: number): string {
  const width = visibleLength(right);
  if (width + 2 > cols) return fit(left, cols);
  const head = fit(left, cols - width - 1);
  return head + " ".repeat(Math.max(0, cols - width - 1 - visibleLength(head))) + " " + right;
}

/** The dependency tree row: ├─ └─ connectors to the primary prerequisite, ▾/▸ fold marker, the status dot, `#n name`,
 * then `+#n` for the other prerequisites and the status label at the right edge. */
function treeRow(tasks: TreeTask[], nodes: OutlineNode[], node: OutlineNode, selected: boolean, collapsed: ReadonlySet<string>, frame: number, cols: number): string {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const roots = nodes.filter(n => n.depth === 0).map(n => n.id);
  const last = (n: OutlineNode) => (n.parent ? byId.get(n.parent)!.children : roots).at(-1) === n.id;
  const i = tasks.findIndex(t => t.id === node.id), task = tasks[i]!, number = task.number ?? i + 1;
  let prefix = "";
  for (let a = node.parent ? byId.get(node.parent) : undefined; a && a.depth > 0; a = a.parent ? byId.get(a.parent) : undefined) prefix = (last(a) ? "   " : "│  ") + prefix;
  const connector = node.depth ? (last(node) ? "└─ " : "├─ ") : "";
  const fold = node.children.length ? (collapsed.has(node.id) ? paint(1, "▸ ") : "▾ ") : "";
  const hidden = node.children.length && collapsed.has(node.id) ? dim(` (${node.children.length} hidden)`) : "";
  const extra = task.dependsOn.filter(id => id.toLowerCase() !== node.parent?.toLowerCase() && byId.has(tasks.find(t => t.id.toLowerCase() === id.toLowerCase())?.id ?? ""))
    .map(id => `+#${tasks.find(t => t.id.toLowerCase() === id.toLowerCase())!.number ?? tasks.findIndex(t => t.id.toLowerCase() === id.toLowerCase()) + 1}`).join(" ");
  const title = clip(`#${number} ${plainText(task.name)}`, cols);
  const left = `${selected ? paint(1, "▶") : " "} ${dim(prefix + connector)}${fold}${dot(task, frame)} ${selected ? paint(1, title) : title}${hidden}`;
  const right = `${extra ? dim(extra) + " " : ""}${paint(statusColor(task), rowLabel(task))}`;
  return spread(left, right, cols);
}

function detailFields(tasks: TreeTask[], selected: TreeTask): [string, string][] {
  const dependencies = selected.dependsOn.map(id => {
    const i = tasks.findIndex(t => t.id.toLowerCase() === id.toLowerCase());
    return `#${tasks[i]!.number ?? i + 1} ${tasks[i]!.name}${tasks[i]!.removedAt ? " (removed from list; retained)" : ""}`;
  });
  const fields: [string, string][] = [
    [`Task #${selected.number ?? tasks.indexOf(selected) + 1} · ${status(selected)}`, selected.name],
    ["Lifecycle", taskStatusLabels[selected.status]],
    ["UUID", selected.id],
    ["Created", selected.createdAt],
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

function detailLines(tasks: TreeTask[], selected: TreeTask | undefined, cols: number, frame: number): string[] {
  if (!selected) return safeLines("Tasks: No tasks", cols);
  const lines: string[] = [];
  const fields = detailFields(tasks, selected);
  const dependents = tasks.filter(t => !t.removedAt && t.dependsOn.some(id => id.toLowerCase() === selected.id.toLowerCase()));
  for (const [name, value] of fields.slice(0, 1)) lines.push(...safeLines(`${name}: ${value}`, cols));
  lines.push(fit(`${track(selected, frame)} ${dim("worker → review → PR → merged")}`, cols));
  if (dependents.length) lines.push(...safeLines(`Unblocks: ${dependents.map(t => `#${t.number ?? tasks.indexOf(t) + 1} ${t.name}`).join("; ")}`, cols));
  lines.push("");
  for (const [name, value] of fields.slice(1)) {
    lines.push(...safeLines(`${name}: ${value}`, cols), "");
  }
  for (const [checkpoint, at] of Object.entries(selected.checkpoints ?? {})) lines.push(...safeLines(`${checkpoint}: ${at}`, cols));
  const pr = selected.archive?.pr ?? selected.pr;
  if (pr) {
    for (const label of safeLines(`PR: ${pr.repository} #${pr.number}`, cols)) {
      lines.push(`\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07`);
    }
    lines.push(...safeLines(pr.url, cols));
  } else lines.push(...safeLines("PR: not recorded", cols));
  return lines;
}

const LEGEND = "├─ first prerequisite · +#n other prerequisites · ▾▸ fold";
function compose(p: Panels, graph: string[], detail: string[], detailY: number, footer: string): string[] {
  const lines = [p.cols >= 70 ? fit(`TASKS  ${dim(LEGEND)}`, p.cols) : safeLines("TASKS", p.cols)[0]!];
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
  let p = panels(options);
  try {
    const tasks = treeTasks(input), collapsed = options.collapsed ?? new Set<string>(), frame = options.frame ?? 0;
    const nodes = outline(tasks, collapsed);
    p = panels(options, nodes.length);
    const selected = tasks.find(t => t.id === options.selectedId && nodes.some(n => n.id === t.id)) ?? tasks.find(t => t.id === nodes[0]?.id);
    const view = { cols: p.graphCols, rows: p.graphRows, x: 0,
      y: offset(options.graphY, Math.max(0, nodes.length - p.graphRows)) };
    if (options.revealSelected && selected) {
      const y = nodes.findIndex(n => n.id === selected.id);
      view.y = Math.max(y - view.rows + 1, Math.min(view.y, y));
    }
    const hits: TaskTreeHit[] = [], lines: string[] = [];
    for (const [row, node] of nodes.slice(view.y, view.y + view.rows).entries()) {
      const i = tasks.findIndex(t => t.id === node.id), task = tasks[i]!;
      lines.push(treeRow(tasks, nodes, node, node.id === selected?.id, collapsed, frame, view.cols));
      hits.push({ id: task.id, number: task.number ?? i + 1, row: row + 1, col: 0, width: view.cols });
    }
    const detail = detailLines(tasks, selected, p.detailCols, frame);
    const dy = offset(options.detailY, Math.max(0, detail.length - p.detailRows));
    if (!nodes.length) lines[0] = "No tasks";
    const footer = `Outline y=${view.y}/${Math.max(0, nodes.length - view.rows)}; details=${dy}/${Math.max(0, detail.length - p.detailRows)}`;
    return { nodes, animated: nodes.slice(view.y, view.y + view.rows).some(n => active(tasks.find(t => t.id === n.id)!)),
      lines: compose(p, lines, detail, dy, footer), hits, selectedId: selected?.id,
      order: nodes.map(n => n.id), errors: [], graph: { ...view, width: view.cols, height: nodes.length },
      details: { height: detail.length, y: dy, rows: p.detailRows } };
  } catch (error) { return failed(p, error); }
}
