import { expect, test } from "bun:test";
import { taskTreeView, type Task } from "../../protocol/task/tasks";
import { navigateOutline, taskRows, taskSections } from "./task-tree";
import { ARCHIVED_SECTION } from "./work-view";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, deps: number[] = [], name = `Task ${n}`): Task => ({
  id: id(n), name, summary: "Durable summary", branch: "feat/tree", status: "queued",
  createdAt: "2026-01-01", updatedAt: "2026-01-02", revision: 1, dependsOn: deps.map(id), runs: [], history: [],
});
const sample = () => [task(1, [5], "Restore session draft"), task(2, [1], "Export task history"), task(3, [5], "Narrow-terminal keys"), task(4, [5], "Reduce footer redraws"), task(5, [], "Clarify empty inbox"), task(6, [2, 3, 4], "Document task recovery")];
const pr = { repository: "sample/repo", number: 105, url: "https://github.com/sample/repo/pull/105", head: "a".repeat(40) };
const label = (row: { lead?: string; name: string }) => (row.lead ?? "") + row.name;

test("the outline flattens into rows: connectors and fold markers lead the name, other prerequisites and the PR are info", () => {
  const tasks = sample(), collapsed = new Set<string>();
  const all = taskRows(tasks, collapsed, false), out = { ...all, rows: all.rows.filter(row => !row.heading) };
  expect(all.rows[0]).toMatchObject({ heading: true, name: "▾ Jan 2, 2026 (6)" }); // one day, one heading
  expect(all.rows).toEqual(taskRows([...tasks].reverse().map(taskTreeView), collapsed, false).rows);
  expect(out.rows.map(row => row.id)).toEqual([5, 1, 2, 6, 3, 4].map(id));
  expect(out.rows.map(label)).toEqual(["▾ #5 Clarify empty inbox", "├─ ▾ #1 Restore session draft", "│  └─ ▾ #2 Export task history",
    "│     └─ #6 Document task recovery", "├─ #3 Narrow-terminal keys", "└─ #4 Reduce footer redraws"]);
  expect(out.rows[3]).toMatchObject({ status: "queued", info: "+#3 +#4" }); // other prerequisites stay explicit
  expect(out.rows[0]!.name).toBe("#5 Clarify empty inbox"); // find matches the name, never the connectors
  expect(navigateOutline(out.nodes, id(1), collapsed, "right")).toBe(id(2));
  expect(navigateOutline(out.nodes, id(1), collapsed, "down", true)).toBe(id(3));
  expect(navigateOutline(out.nodes, id(1), collapsed, "left")).toBe(id(1)); // folds
  const folded = { ...taskRows(tasks, collapsed, false), rows: taskRows(tasks, collapsed, false).rows.filter(row => !row.heading) };
  expect(folded.rows.map(row => row.id)).toEqual([5, 1, 3, 4].map(id));
  expect(label(folded.rows[1]!)).toBe("├─ ▸ #1 Restore session draft");
  expect(folded.rows[1]!.info).toBe("1 hidden");
  expect(navigateOutline(folded.nodes, id(1), collapsed, "left")).toBe(id(5));
  expect(navigateOutline(folded.nodes, id(1), collapsed, "right")).toBe(id(1));
  expect(collapsed.size).toBe(0);
});

test("status words carry the state's colour; a PR and running work show as info; archived tasks sit under their section", () => {
  const tasks = Array.from({ length: 4 }, (_, i) => task(i + 1));
  tasks[1]!.runs = [{ id: "run", agent: "agent", role: "worker", state: "started", preparedAt: "today" }];
  tasks[2]!.archive = { reason: "merged", mergedAt: "today", archivedAt: "today", pr };
  tasks[3]!.removedAt = "2026-01-03";
  const shut = taskRows(tasks, new Set(), false).rows.filter(row => !row.heading), open = taskRows(tasks, new Set(), true).rows.filter(row => !row.heading);
  expect(shut.map(row => [row.status, row.color])).toEqual([["queued", 90], ["working", 36], ["merged", 35], [undefined, undefined]]);
  expect(shut[1]!.info).toBe("working"); expect(shut[2]!.info).toBe("PR #105");
  expect(shut[3]).toMatchObject({ id: ARCHIVED_SECTION, name: "▸ Archived (1)", section: true });
  expect(open.map(row => row.name)).toEqual(["#1 Task 1", "#2 Task 2", "#3 Task 3", "▾ Archived (1)", "#4 Task 4"]);
});

test("tasks are listed by when they were last touched, newest first, under a heading per day; a tree moves as one", () => {
  const at = (n: number, updatedAt: string, deps: number[] = []) => ({ ...task(n, deps), updatedAt });
  const now = new Date(2026, 0, 10, 15).getTime(), local = (day: number, hour: number) => new Date(2026, 0, day, hour).toISOString();
  // #1 was created first and touched today; #3 depends on #2 and was touched yesterday, so both sit under Yesterday.
  const tasks = [at(1, local(10, 9)), at(2, local(5, 9)), at(3, local(9, 23), [2]), at(4, local(10, 14)), at(5, local(7, 12))];
  const { rows, nodes } = taskRows(tasks, new Set(), false, now);
  expect(rows.map(row => row.heading ? row.name : label(row))).toEqual(["▾ Today (2)", "#4 Task 4", "#1 Task 1", "▾ Yesterday (2)", "▾ #2 Task 2", "└─ #3 Task 3", "▾ Jan 7, 2026 (1)", "#5 Task 5"]);
  expect(rows.filter(row => row.heading).every(row => row.status === undefined && row.id.startsWith(":day:"))).toBe(true);
  // A folded tree still sits at its hidden member's day.
  expect(taskRows(tasks, new Set([id(2)]), false, now).rows.map(row => row.name).slice(3, 5)).toEqual(["▾ Yesterday (2)", "#2 Task 2"]);
  // A folded day keeps its heading and count; its trees are left out and come back unchanged.
  expect(taskRows(tasks, new Set([":day:2026-01-09"]), false, now).rows.map(row => row.name)).toEqual(["▾ Today (2)", "#4 Task 4", "#1 Task 1", "▸ Yesterday (2)", "▾ Jan 7, 2026 (1)", "#5 Task 5"]);
  const folds = new Set<string>();
  expect(navigateOutline(nodes, id(2), folds, "left")).toBe(id(2)); expect(folds.has(id(2))).toBe(true); // a tree folds first
  expect(navigateOutline(nodes, id(1), folds, "left")).toBe(":day:2026-01-10"); // then ← goes up to the day
  expect(navigateOutline(nodes, ":day:2026-01-10", folds, "left")).toBe(":day:2026-01-10"); expect(folds.has(":day:2026-01-10")).toBe(true);
  expect(navigateOutline(nodes, id(1), new Set(), "down")).toBe(":day:2026-01-09"); // a heading is a row like the Archived one
});

test("details: description, record fields without the UUID, dependencies both ways and the PR as a clickable url", () => {
  const tasks = sample(); tasks[0]!.pr = pr; tasks[0]!.attention = { kind: "blocked", reason: "Need approval" };
  const { tasks: all } = taskRows(tasks, new Set(), false);
  const sections = taskSections(all, all.find(t => t.id === id(1))!);
  expect(sections.map(s => s.title)).toEqual(["Task #1 Restore session draft", "Details", "Depends on", "Pull request"]);
  expect(sections[0]!.text).toBe("Durable summary");
  expect(sections[1]!.fields!.map(([key]) => key)).not.toContain("uuid");
  expect(sections[1]!.fields).toContainEqual(["attention", "blocked: Need approval"]);
  expect(sections[2]!.text).toBe("#5 Clarify empty inbox\nUnblocks: #2 Export task history");
  expect(sections[3]!.fields).toEqual([["url", pr.url, pr.url]]);
  expect(taskSections(all, all.find(t => t.id === id(5))!)[3]).toMatchObject({ fields: [], text: "not recorded" });
});

test("invalid registries fail closed", () => {
  expect(() => taskRows([task(1, [2])], new Set(), false)).toThrow("Dangling prerequisite");
  expect(() => taskRows([task(1, [2]), task(2, [1])], new Set(), false)).toThrow("Dependency cycle");
  expect(() => taskRows([task(1), task(1)], new Set(), false)).toThrow("Duplicate task identity");
  const ready = task(1); ready.status = "ready_to_merge";
  expect(() => taskRows([ready], new Set(), false)).toThrow("ready requires matching validation");
  expect(() => taskRows(Array.from({ length: 257 }, (_, i) => task(i + 1)), new Set(), false)).toThrow("Graph limit");
});
