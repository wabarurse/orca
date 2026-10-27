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
  const opts = { cols: 120, rows: 35, selectedId: id(3) };
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
