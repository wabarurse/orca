// The task registry as rows and details for the shared work page (work-view.ts):
// a dependency outline, flattened with tree connectors and fold markers. Invalid
// registries fail closed (the functions throw; the page shows the error).
import { formatDateTime } from "../../protocol";
import { ARCHIVED_SECTION, DAY_HEADING, archiveTitle, dayName, headingTitle, localDay, type WorkRow, type WorkSection } from "./work-view";
import { publicTaskStatus, taskPublicationMilestone, check, type TaskDisplayStatus, type Task, type TaskTreeView } from "../../protocol/task";
import { plainText } from "./text";
import { treeTasks, type TreeTask } from "./task-tree-data";

/** `count`: the tasks under a day heading, shown or folded away; 0 on every other node. */
export interface OutlineNode { id: string; depth: number; parent?: string; children: string[]; count: number }

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
function outline(tasks: TreeTask[], collapsed: ReadonlySet<string>, history = false, sections = false, now = Date.now()): OutlineNode[] {
  dependencyLayers(tasks); // Validate against retained SQL records before hiding membership.
  if (sections) {
    const archived = tasks.filter(t => t.removedAt);
    return [...byDay(tasks.filter(t => !t.removedAt), collapsed, now), ...(archived.length ? [{ id: ARCHIVED_SECTION, depth: 0, children: [], count: 0 },
      ...(history ? outlineGroup(archived, collapsed) : [])] : [])];
  }
  const visible = new Set(tasks.filter(t => history ? !!t.archive : !t.removedAt).map(t => t.id.toLowerCase()));
  return outlineGroup(tasks.filter(t => visible.has(t.id.toLowerCase())), collapsed);
}
function outlineGroup(input: TreeTask[], collapsed: ReadonlySet<string>): OutlineNode[] {
  const visible = new Set(input.map(t => t.id.toLowerCase()));
  const tasks = input.map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => visible.has(id.toLowerCase())) }));
  const { parents } = dependencyLayers(tasks);
  const primary = parents.map(ps => [...ps].sort((a, b) => a - b)[0]);
  const children = tasks.map((_, i) => tasks.flatMap((t, j) => primary[j] === i ? [t.id] : []));
  const result: OutlineNode[] = [];
  const visit = (i: number, depth: number) => {
    const task = tasks[i]!;
    result.push({ id: task.id, depth, parent: primary[i] === undefined ? undefined : tasks[primary[i]!]!.id, children: children[i]!, count: 0 });
    if (!collapsed.has(task.id)) for (let j = 0; j < tasks.length; j++) if (primary[j] === i) visit(j, depth + 1);
  };
  tasks.forEach((_, i) => { if (primary[i] === undefined) visit(i, 0); });
  return result;
}

/** The listed tasks by when they were last touched, newest first, under a heading per local day. A task is touched
 * by any change to its record (a run starting or ending, its PR, attention, an edit), not only by its creation. A
 * dependency tree moves as one, at its most recently touched member, so a prerequisite never leaves its dependents.
 * A heading is the parent of its day's trees, so it folds like a task: a folded day keeps its heading and count only. */
function byDay(tasks: TreeTask[], collapsed: ReadonlySet<string>, now: number): OutlineNode[] {
  const touched = new Map<string, number>(), size = new Map<string, number>();
  let root = "";
  for (const node of outlineGroup(tasks, new Set())) {
    if (!node.depth) root = node.id;
    const at = Date.parse(tasks.find(t => t.id === node.id)!.updatedAt);
    touched.set(root, Math.max(touched.get(root) ?? 0, Number.isFinite(at) ? at : 0));
    size.set(root, (size.get(root) ?? 0) + 1);
  }
  const trees: OutlineNode[][] = [];
  for (const node of outlineGroup(tasks, collapsed)) if (node.depth) trees.at(-1)!.push(node); else trees.push([node]);
  const result: OutlineNode[] = [];
  let heading: OutlineNode | undefined;
  for (const tree of trees.map((nodes, order) => ({ nodes, order, at: touched.get(nodes[0]!.id)! })).sort((a, b) => b.at - a.at || a.order - b.order)) {
    const day = DAY_HEADING + localDay(new Date(tree.at)), first = tree.nodes[0]!;
    if (day !== heading?.id) result.push(heading = { id: day, depth: 0, children: [], count: 0 });
    heading.children.push(first.id); heading.count += size.get(first.id)!;
    if (!collapsed.has(day)) result.push({ ...first, parent: day }, ...tree.nodes.slice(1));
  }
  return result;
}

function active(task: TreeTask): boolean {
  return !task.archive && !task.attention && task.runs.some(run => run.state === "started" && !run.endedAt);
}

function status(task: TreeTask): TaskDisplayStatus { return publicTaskStatus(task); }

/** The row and status text always share the same state and colour. Fixed xterm-256 colours, not the theme's eight
 * (whose "magenta" is pink in many themes), so a state looks the same in every terminal: merged is always purple. */
export function taskStateColor(state: TaskDisplayStatus): string {
  return ({ queued: "38;5;245", working: "38;5;80", waiting: "38;5;221", "pr open": "38;5;114", merged: "38;5;141", closed: "38;5;203" })[state];
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

/** Every task as a table row, newest activity first under a heading per day, each dependency tree in outline order: connectors to the primary prerequisite, ▾/▸ fold marker, `#n name`,
 * the status word in its colour, and the PR (plus `+#n` for the other prerequisites) as info. Archived tasks sit under
 * their own section row. */
export function taskRows(input: readonly (Task | TaskTreeView)[], collapsed: ReadonlySet<string>, history: boolean, now = Date.now()): { tasks: TreeTask[]; nodes: OutlineNode[]; rows: (WorkRow & { section?: true; heading?: true })[] } {
  const tasks = treeTasks(input), nodes = outline(tasks, collapsed, history, true, now);
  const byId = new Map(nodes.map(n => [n.id, n])), task = new Map(tasks.map(t => [t.id.toLowerCase(), t]));
  const number = (t: TreeTask) => t.number ?? tasks.indexOf(t) + 1;
  const roots = (archived: boolean) => nodes.filter(n => n.depth === 0 && task.has(n.id.toLowerCase()) && !!task.get(n.id.toLowerCase())!.removedAt === archived).map(n => n.id);
  const rows = nodes.map((node): WorkRow & { section?: true; heading?: true } => {
    if (node.id === ARCHIVED_SECTION) return { id: node.id, name: archiveTitle(tasks.filter(t => t.removedAt).length, history), section: true };
    if (node.id.startsWith(DAY_HEADING)) return { id: node.id, name: headingTitle(dayName(node.id, now), node.count, !collapsed.has(node.id)), heading: true };
    const t = task.get(node.id.toLowerCase())!;
    const last = (n: OutlineNode) => (n.parent ? byId.get(n.parent)!.children : roots(!!t.removedAt)).at(-1) === n.id;
    let prefix = "";
    for (let a = node.parent ? byId.get(node.parent) : undefined; a && a.depth > 0; a = a.parent ? byId.get(a.parent) : undefined) prefix = (last(a) ? "   " : "│  ") + prefix;
    const fold = node.children.length ? (collapsed.has(node.id) ? "▸ " : "▾ ") : "";
    const extra = t.dependsOn.filter(id => id.toLowerCase() !== node.parent?.toLowerCase()).flatMap(id => task.has(id.toLowerCase()) ? [`+#${number(task.get(id.toLowerCase())!)}`] : []);
    const pr = t.archive?.pr ?? t.pr;
    return { id: t.id, lead: prefix + (node.depth ? (last(node) ? "└─ " : "├─ ") : "") + fold, name: `#${number(t)} ${plainText(t.name)}`,
      status: status(t), color: taskStateColor(status(t)),
      info: [pr && `PR #${pr.number}`, extra.join(" "), fold === "▸ " && `${node.children.length} hidden`, active(t) && activity(t)].filter(Boolean).join(" · ") };
  });
  return { tasks, nodes, rows };
}

/** What the details pane says about one task: description, record fields, dependencies both ways and the PR link. */
export function taskSections(tasks: TreeTask[], selected: TreeTask): WorkSection[] {
  const label = (t: TreeTask) => `#${t.number ?? tasks.indexOf(t) + 1} ${t.name}`;
  const fields: [string, string][] = [["state", status(selected)], ["created", formatDateTime(selected.createdAt)]];
  if (active(selected)) fields.push(["activity", activity(selected)]);
  const milestone = taskPublicationMilestone(selected);
  if ("label" in milestone) fields.push(["publication", `${milestone.label} (historical)`]);
  if ("observedAt" in milestone) fields.push(["observed", `${formatDateTime(milestone.observedAt)} (historical; not merge permission)`]);
  if (selected.attention) fields.push(["attention", `${selected.attention.kind}: ${selected.attention.reason}`]);
  const latest = selected.runs.at(-1);
  if (latest) fields.push(["run", `${latest.role}: ${latest.state}`]);
  if (selected.readiness) fields.push(["validation", `${selected.readiness.checks}: ${selected.readiness.validation}`]);
  for (const [checkpoint, at] of Object.entries(selected.checkpoints ?? {})) fields.push([checkpoint, formatDateTime(at)]);
  const needs = selected.dependsOn.flatMap(id => { const t = tasks.find(t => t.id.toLowerCase() === id.toLowerCase()); return t ? [`${label(t)}${t.removedAt ? " (removed from list; retained)" : ""}`] : []; });
  const unblocks = tasks.filter(t => !t.removedAt && t.dependsOn.some(id => id.toLowerCase() === selected.id.toLowerCase())).map(label);
  const pr = selected.archive?.pr ?? selected.pr;
  return [
    { title: `Task ${label(selected)}`, text: selected.summary || "No description recorded." },
    { title: "Details", fields },
    { title: "Depends on", text: [needs.join("; ") || "none", ...(unblocks.length ? [`Unblocks: ${unblocks.join("; ")}`] : [])].join("\n") },
    { title: "Pull request", fields: pr ? [["url", pr.url, pr.url]] : [], ...(pr ? {} : { text: "not recorded" }) },
  ];
}
