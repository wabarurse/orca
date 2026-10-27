import { expect, test } from "bun:test";
import { taskTreeView, type Task } from "../../protocol/tasks";
import { navigateOutline, renderTaskTree } from "./task-tree";
import { plainText, visibleLength } from "./text";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, deps: number[] = [], name = `Task ${n}`): Task => ({
  id: id(n), name, summary: "Durable summary", branch: "feat/tree", status: "queued",
  createdAt: "2026-01-01", updatedAt: "2026-01-02", revision: 1, dependsOn: deps.map(id), runs: [], history: [],
});
const sample = () => [task(1, [5], "Restore session draft"), task(2, [1], "Export task history"), task(3, [5], "Narrow-terminal keys"), task(4, [5], "Reduce footer redraws"), task(5, [], "Clarify empty inbox"), task(6, [2, 3, 4], "Document task recovery")];
const pr = { repository: "sample/repo", number: 105, url: "https://github.com/sample/repo/pull/105", head: "a".repeat(40) };


test("selected details preserve warnings, runs, PR/readiness and missing facts with independent scroll", () => {
  const t = task(1); t.attention = { kind: "blocked", reason: "Need a decision" }; t.pr = pr;
  t.status = "ready_to_merge"; t.readiness = { head: pr.head, run: "review", validatedAt: "today", validation: "Evidence checked", checks: "not_configured" };
  t.runs = [{ id: "review", agent: "reviewer", role: "reviewer", state: "stopped", preparedAt: "yesterday" }];
  const opts = { cols: 120, rows: 200 }, full = renderTaskTree([t], opts).lines.join("\n");
  for (const value of ["Need a decision", "Evidence checked", "not_configured", "Dependencies: none"]) expect(full).toContain(value);
  const small = renderTaskTree([t], { cols: 20, rows: 12, detailY: 99999 });
  expect(small.details.y).toBe(small.details.height - small.details.rows);
  expect(small.lines.join("\n")).toContain("sample/repo"); expect(small.graph.y).toBe(0);
  expect(renderTaskTree([task(1)], opts).lines.join("\n")).toContain("PR: not recorded");
});

test("empty, malformed, cycle, dangling, duplicate identity and graph limits are explicit", () => {
  expect(renderTaskTree([], { cols: 80, rows: 24 }).lines.join("\n")).toContain("No tasks");
  for (const input of [[task(1, [2])], [task(1, [2]), task(2, [1])], [task(1), task(1)], [{ ...task(1), dependsOn: "bad" }], Array.from({ length: 257 }, (_, i) => task(i))]) {
    const out = renderTaskTree(input as Task[], { cols: 80, rows: 24 });
    expect(out.errors.length).toBeGreaterThan(0); expect(out.hits).toEqual([]); expect(out.lines.join("\n")).toContain("ERROR:");
  }
});

test("independent roots, wide Unicode and hostile text are safe at narrow and scrolled bounds", () => {
  const evil = '\x1b]0;title\x07\x1b[31m界🙂é\u202eevil\x1b[0m';
  const tasks = [task(1, [], evil), task(2, [], "Second root"), task(3, [1, 2])];
  tasks[0]!.summary = evil; tasks[0]!.branch = evil;
  for (const cols of [1, 2, 20, 80, 120]) {
    const out = renderTaskTree(tasks, { cols, rows: 24, graphX: 1, selectedId: id(1) });
    expect(out.lines.length).toBeLessThanOrEqual(24);
    for (const line of out.lines) { expect(visibleLength(line)).toBeLessThanOrEqual(cols); expect(plainText(line)).not.toMatch(/[\x1b\x07\u202e]/); expect(line).not.toContain("title"); }
    for (const h of out.hits) expect(h.col + h.width).toBeLessThanOrEqual(out.graph.cols);
  }
  const full = renderTaskTree(tasks, { cols: 120, rows: 35 });
  expect(full.hits.some(h => h.width === 2)).toBe(true);
  const scroll = renderTaskTree(Array.from({ length: 100 }, (_, i) => task(i + 1, i ? [i] : [])), { cols: 80, rows: 24, graphX: 99999, graphY: 99999 });
  expect(scroll.graph.x).toBe(scroll.graph.width - scroll.graph.cols);
  expect(scroll.graph.y).toBe(scroll.graph.height - scroll.graph.rows);
  expect(scroll.lines.at(-1)).toContain("Outline y=");
});

test("one-cell metadata viewport stays cell-safe when scrolled into CJK and emoji fields", () => {
  const t = task(1, [], "界🙂"); t.summary = "🙂界";
  const options = { cols: 1, rows: 10, selectedId: t.id };
  const first = renderTaskTree([t], options);
  let replacements = 0;
  for (let detailY = 0; detailY < first.details.height; detailY += 3) {
    const result = renderTaskTree([t], { ...options, detailY });
    expect(result.errors).toEqual([]);
    for (const line of result.lines) expect(visibleLength(line)).toBeLessThanOrEqual(1);
    const metadata = result.lines.slice(result.graph.rows + 1, -1);
    replacements += metadata.filter(line => line === "…").length;
  }
  expect(replacements).toBeGreaterThan(0);
});

test("malformed identities and durable metadata reject coherently without hits or invented facts", () => {
  const malformed = [
    { ...task(1), id: 12 }, { ...task(1), id: "bad" }, { ...task(1), runs: undefined },
    { ...task(1), name: null }, { ...task(1), runs: [{}] }, { ...task(1), attention: { kind: "blocked" } },
    { ...task(1), pr: {} }, { ...task(1), readiness: {} }, { ...task(1), archive: {} },
    { ...task(1), status: "done" }, { ...taskTreeView(task(1)), source: null },
  ];
  for (const record of malformed) {
    const out = renderTaskTree([record] as Task[], { cols: 80, rows: 24 });
    expect(out.errors.length).toBe(1); expect(out.hits).toEqual([]);
    expect(out.selectedId).toBeUndefined(); expect(out.lines.join("\n")).toContain("ERROR:");
  }
  const projection = taskTreeView(task(1)); projection.name = "Untrusted display override";
  expect(renderTaskTree([projection], { cols: 120, rows: 35 }).lines.join("\n")).not.toContain(projection.name);
});

test("metadata budgets reject before expensive processing and history is never read", () => {
  const history = task(1);
  Object.defineProperty(history, "history", { get() { throw new Error("History must not be read"); } });
  expect(renderTaskTree([history], { cols: 120, rows: 35 }).errors).toEqual([]);
  const hugeField = { ...task(1), summary: "界".repeat(8193) };
  const tooManyRuns = { ...task(1), runs: Array(129).fill(null) };
  const registry = Array.from({ length: 40 }, (_, i) => ({ ...task(i + 1), summary: "x".repeat(8192) }));
  for (const records of [[hugeField], [tooManyRuns], registry]) {
    const result = renderTaskTree(records, { cols: 80, rows: 24 });
    expect(result.errors.join(" ")).toContain("Metadata limit:"); expect(result.hits).toEqual([]);
  }
});




test("canonical outline references other prerequisites and navigates visible depths", () => {
  const tasks = sample();
  const collapsed = new Set<string>();
  const options = { cols: 120, rows: 35, collapsed };
  const out = renderTaskTree(tasks, options);
  expect(out).toEqual(renderTaskTree([...tasks].reverse().map(taskTreeView), options));
  expect(out.order).toEqual([5, 1, 2, 6, 3, 4].map(id));
  expect(out.lines[2]).toStartWith("   #1");
  expect(out.lines[3]).toStartWith("     #2");
  expect(renderTaskTree(tasks, { ...options, selectedId: id(6), rows: 100 }).lines.join("\n")).toContain("#3 Narrow-terminal keys");
  expect(new Set(out.nodes.map(n => n.id)).size).toBe(tasks.length);
  expect(navigateOutline(out.nodes, id(1), collapsed, "right")).toBe(id(2));
  expect(navigateOutline(out.nodes, id(1), collapsed, "down", true)).toBe(id(3));
  expect(navigateOutline(out.nodes, id(3), collapsed, "left", true)).toBe(id(1));
  expect(navigateOutline(out.nodes, id(1), collapsed, "left")).toBe(id(1));
  const folded = renderTaskTree(tasks, options);
  expect(folded.order).toEqual([5, 1, 3, 4].map(id));
  expect(navigateOutline(folded.nodes, id(1), collapsed, "left")).toBe(id(5));
  expect(navigateOutline(folded.nodes, id(1), collapsed, "right")).toBe(id(1));
  expect(collapsed.size).toBe(0);
});

test("only unended started runs animate; merged checkbox requires archive evidence", () => {
  const tasks = Array.from({ length: 6 }, (_, i) => task(i + 1));
  const run = { id: "run", agent: "agent", role: "worker" as const, state: "started" as const, preparedAt: "today" };
  tasks[1]!.runs = [run];
  tasks[2]!.runs = [{ ...run, role: "reviewer" }];
  tasks[3]!.runs = [{ ...run, state: "stopped" }];
  tasks[4]!.runs = [{ ...run, endedAt: "today" }];
  tasks[5]!.archive = { reason: "merged", mergedAt: "today", archivedAt: "today", pr };
  const a = renderTaskTree(tasks, { cols: 120, rows: 35 });
  const b = renderTaskTree(tasks, { cols: 120, rows: 35, frame: 1 });
  expect(a.animated).toBe(true);
  expect(a.lines).toEqual(b.lines);
  for (const color of [90, 33, 35]) expect(a.lines.join("\n")).toContain(`\x1b[${color}m●`);
  expect(renderTaskTree(tasks, { cols: 120, rows: 35, selectedId: id(4) }).lines.join("\n")).toContain("stopped");
  expect(renderTaskTree(tasks.slice(3), { cols: 120, rows: 35 }).animated).toBe(false);
  tasks[1]!.attention = { kind: "blocked", reason: "stopped externally" };
  expect(renderTaskTree([tasks[1]!], { cols: 120, rows: 35 }).animated).toBe(false);
});

 test("details stay below list with truthful ready and archived native links", () => {
  const ready = task(1); ready.pr = pr; ready.status = "ready_to_merge";
  ready.readiness = { head: pr.head, run: "r", validatedAt: "today", validation: "checked", checks: "passed" };
  const merged = task(2, [1]); merged.archive = { reason: "merged", mergedAt: "today", archivedAt: "today", pr };
  for (const cols of [80, 120]) {
    const out = renderTaskTree([ready, merged], { cols, rows: 35, selectedId: merged.id });
    expect(out.lines.slice(0, out.graph.rows + 1).join("\n")).not.toContain("Overview");
    expect(out.lines.join("\n")).toContain("\x1b[32m●");
    expect(out.lines.join("\n")).toContain("Task #2 · Merged");
    expect(out.lines.join("\n")).toContain("Dependencies: #1 Task 1");
    expect(out.lines.join("\n")).toContain(`\x1b]8;;${pr.url}\x07PR: sample/repo #105`);
  }
  ready.readiness.head = "b".repeat(40);
  expect(renderTaskTree([ready], { cols: 80, rows: 24 }).errors.join(" ")).toContain("ready requires matching validation");
});
