import { expect, test } from "bun:test";
import { taskTreeView, type Task } from "../../protocol/tasks";
import { renderTaskTree } from "./task-tree";
import { visibleLength } from "./text";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, deps: number[] = [], name = `Task ${n}`): Task => ({
  id: id(n), name, summary: "Durable summary", branch: "feat/tree", status: "queued",
  createdAt: "2026-01-01", updatedAt: "2026-01-02", revision: 1, dependsOn: deps.map(id), runs: [], history: [],
});
const sample = () => [task(1, [5], "Restore session draft"), task(2, [1], "Export task history"), task(3, [5], "Narrow-terminal keys"), task(4, [5], "Reduce footer redraws"), task(5, [], "Clarify empty inbox"), task(6, [2, 3, 4], "Document task recovery")];
const pr = { repository: "sample/repo", number: 105, url: "https://github.com/sample/repo/pull/105", head: "a".repeat(40) };

test("fork/join, archived prerequisite, deterministic labels and UUID selection, cell hits", () => {
  const tasks = sample();
  tasks[4]!.archive = { reason: "merged", mergedAt: "2026-01-02", archivedAt: "2026-01-03", pr };
  const opts = { cols: 300, rows: 35, selectedId: id(3) };
  const a = renderTaskTree(tasks, opts), b = renderTaskTree([...tasks].reverse().map(taskTreeView), opts);
  expect(a).toEqual(b); expect(a.errors).toEqual([]); expect(a.selectedId).toBe(id(3));
  expect(new Set(a.hits.map(h => h.id)).size).toBe(6);
  const row = (n: number) => a.hits.find(h => h.id === id(n))!.row;
  expect(row(5)).toBeLessThan(row(1)); expect(row(1)).toBeLessThan(row(2));
  for (const n of [2, 3, 4]) expect(row(n)).toBeLessThan(row(6));
  expect(a.lines.join("\n")).toContain("SELECTED [3]");
  expect(a.lines.join("\n")).toContain("╪");
  for (const hit of a.hits) { expect(hit.col + hit.width).toBeLessThanOrEqual(a.graph.cols); expect(hit.row).toBeLessThan(a.lines.length); }
  const merged = renderTaskTree(tasks, { ...opts, rows: 200, selectedId: id(5) }).lines.join("\n");
  expect(merged).toContain("Lifecycle: merged"); expect(merged).toContain("Verified archive:");
});

test("selected details preserve warnings, runs, PR/readiness and missing facts with independent scroll", () => {
  const t = task(1); t.attention = { kind: "blocked", reason: "Need a decision" }; t.pr = pr;
  t.status = "ready_to_merge"; t.readiness = { head: pr.head, run: "review", validatedAt: "today", validation: "Evidence checked", checks: "not_configured" };
  t.runs = [{ id: "review", agent: "reviewer", role: "reviewer", state: "stopped", preparedAt: "yesterday" }];
  const opts = { cols: 120, rows: 200 }, full = renderTaskTree([t], opts).lines.join("\n");
  for (const value of ["Need a decision", "Evidence checked", "not_configured", "stopped", "not recorded", "Dependencies: none"]) expect(full).toContain(value);
  const small = renderTaskTree([t], { cols: 20, rows: 12, detailY: 99999 });
  expect(small.details.y).toBe(small.details.height - small.details.rows);
  expect(small.lines.join("\n")).toContain("Revision: 1"); expect(small.graph.y).toBe(0);
  expect(renderTaskTree([task(1)], opts).lines.join("\n")).toContain("not inferred");
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
    for (const line of out.lines) { expect(visibleLength(line)).toBeLessThanOrEqual(cols); expect(line).not.toMatch(/[\x1b\x07\u202e]/); }
    for (const h of out.hits) expect(h.col + h.width).toBeLessThanOrEqual(out.graph.cols);
  }
  const full = renderTaskTree(tasks, { cols: 120, rows: 35 });
  expect(full.hits.some(h => h.width === 2)).toBe(true);
  const scroll = renderTaskTree(Array.from({ length: 100 }, (_, i) => task(i + 1, i ? [i] : [])), { cols: 80, rows: 24, graphX: 99999, graphY: 99999 });
  expect(scroll.graph.x).toBe(scroll.graph.width - scroll.graph.cols);
  expect(scroll.graph.y).toBe(scroll.graph.height - scroll.graph.rows);
  expect(scroll.lines.at(-1)).toContain("Graph x=");
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
  const expanded = task(1);
  expanded.runs = Array.from({ length: 10 }, () => ({ id: "r", agent: "a", role: "worker", state: "started", preparedAt: "x".repeat(8192) }));
  for (const records of [[hugeField], [tooManyRuns], registry, [expanded]]) {
    const result = renderTaskTree(records, { cols: 80, rows: 24 });
    expect(result.errors.join(" ")).toContain("Metadata limit:"); expect(result.hits).toEqual([]);
  }
});

test("skip-layer dependency crosses an unrelated incoming route without adding a join", () => {
  const tasks = [task(1), task(2), task(3, [1]), task(4, [2]), task(5, [1, 3, 4])];
  const out = renderTaskTree(tasks, { cols: 300, rows: 35 });
  expect(out.errors).toEqual([]);
  // 33-cell lanes: edge 1→5 crosses the incoming route 1→3 at (68,2).
  // Only the shared source and destination endpoints are junctions.
  expect(out.lines[3]![68]).toBe("╪"); expect(out.lines[3]![2]).toBe("└");
  expect(out.lines[3]![134]).toBe("┐");
  const nodeRows = tasks.map(t => new Set(out.hits.filter(h => h.id === t.id).map(h => h.row)));
  for (const rows of nodeRows) expect(rows.size).toBe(1);
  expect([...nodeRows[4]!][0]!).toBeGreaterThan([...nodeRows[2]!][0]!);
  const clipped = renderTaskTree(tasks, { cols: 20, rows: 24, graphX: 40 });
  expect(clipped.lines.join("\n")).toContain("╪");
});


test("disconnected registries use vertical named rows and reveal keeps UUID/cell mapping", () => {
  const singletons = Array.from({ length: 24 }, (_, i) => task(i + 1, [], `Independent task number ${i + 1}`));
  const connected = [task(25), task(26, [25]), task(27, [25]), task(28, [26, 27]), task(29), task(30, [29]), task(31, [29]), task(32, [30, 31])];
  for (const cols of [80, 120]) {
    const options = { cols, rows: cols === 80 ? 24 : 35 };
    const only = renderTaskTree(singletons, options);
    expect(only.graph.width).toBe(only.graph.cols);
    expect(only.graph.height).toBe(24);
    expect(only.lines[2]).toContain("[2] Independent task number 2");
    const tasks = [...singletons, ...connected];
    const top = renderTaskTree(tasks, options);
    expect(top.graph.width).toBeLessThanOrEqual(4 * 24);
    const revealed = renderTaskTree(tasks, { ...options, selectedId: id(24), revealSelected: true });
    expect(revealed.hits.some(h => h.id === id(24))).toBe(true);
    expect(revealed.lines.join("\n")).toContain("▶[24] Independent task number 24");
    const last = renderTaskTree(tasks, { ...options, selectedId: id(32), revealSelected: true });
    expect(last.hits.some(h => h.id === id(32))).toBe(true);
    expect(last.order).toEqual(tasks.map(t => t.id));
    const back = renderTaskTree(tasks, { ...options, graphX: last.graph.x, graphY: last.graph.y, selectedId: id(1), revealSelected: true });
    expect(back.graph.x).toBe(0); expect(back.graph.y).toBe(0);
    expect(back.lines[1]).toContain("▶[1] Independent task number 1");
  }
});

test("reveal fits painted label cells, including right-clipped origins and narrow Unicode", () => {
  const tasks = [task(1), task(2, [1]), task(3, [1]), task(4, [2, 3], "界🙂界🙂界🙂界🙂")];
  // The selected origin (72) already lies inside an 80-cell viewport.
  for (const cols of [1, 4, 8, 20, 80, 120]) {
    const options = { cols, rows: 35, selectedId: id(4), graphY: 999 };
    const out = renderTaskTree(tasks, { ...options, revealSelected: true });
    const hits = out.hits.filter(h => h.id === id(4));
    const row = out.lines[hits[0]!.row]!;
    expect(out.errors).toEqual([]);
    expect(out.graph.x).toBeLessThanOrEqual(out.graph.width - out.graph.cols);
    expect(hits.reduce((sum, h) => sum + h.width, 0)).toBe(cols < 5 ? cols : 5 + 2 * Math.min(8, Math.floor((Math.min(cols, out.graph.cols) - 5) / 2)));
    if (cols >= 5) expect(row).toContain("▶[4] ");
    if (cols >= 24) expect(row).toContain("▶[4] 界🙂界🙂界🙂界🙂");
    if (cols === 80) expect(out.graph.x).toBe(13);
    // Without the one-shot request manual offsets are not pulled toward selection.
    const manual = renderTaskTree(tasks, { ...options, graphX: 0 });
    expect(manual.graph.x).toBe(0);
  }
});
