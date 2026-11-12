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
  const out = taskRows(tasks, collapsed, false);
  expect(out.rows).toEqual(taskRows([...tasks].reverse().map(taskTreeView), collapsed, false).rows);
  expect(out.rows.map(row => row.id)).toEqual([5, 1, 2, 6, 3, 4].map(id));
  expect(out.rows.map(label)).toEqual(["▾ #5 Clarify empty inbox", "├─ ▾ #1 Restore session draft", "│  └─ ▾ #2 Export task history",
    "│     └─ #6 Document task recovery", "├─ #3 Narrow-terminal keys", "└─ #4 Reduce footer redraws"]);
  expect(out.rows[3]).toMatchObject({ status: "queued", info: "+#3 +#4" }); // other prerequisites stay explicit
  expect(out.rows[0]!.name).toBe("#5 Clarify empty inbox"); // find matches the name, never the connectors
  expect(navigateOutline(out.nodes, id(1), collapsed, "right")).toBe(id(2));
  expect(navigateOutline(out.nodes, id(1), collapsed, "down", true)).toBe(id(3));
  expect(navigateOutline(out.nodes, id(1), collapsed, "left")).toBe(id(1)); // folds
  const folded = taskRows(tasks, collapsed, false);
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
  const shut = taskRows(tasks, new Set(), false).rows, open = taskRows(tasks, new Set(), true).rows;
  expect(shut.map(row => [row.status, row.color])).toEqual([["queued", 90], ["working", 36], ["merged", 35], [undefined, undefined]]);
  expect(shut[1]!.info).toBe("working"); expect(shut[2]!.info).toBe("PR #105");
  expect(shut[3]).toMatchObject({ id: ARCHIVED_SECTION, name: "▸ Archived (1)", section: true });
  expect(open.map(row => row.name)).toEqual(["#1 Task 1", "#2 Task 2", "#3 Task 3", "▾ Archived (1)", "#4 Task 4"]);
});

test("details: description, record fields, dependencies both ways and the PR as a link", () => {
  const tasks = sample(); tasks[0]!.pr = pr; tasks[0]!.attention = { kind: "blocked", reason: "Need approval" };
  const { tasks: all } = taskRows(tasks, new Set(), false);
  const sections = taskSections(all, all.find(t => t.id === id(1))!);
  expect(sections.map(s => s.title)).toEqual(["Task #1 Restore session draft", "Details", "Depends on", "Pull request"]);
  expect(sections[0]!.text).toBe("Durable summary");
  expect(sections[1]!.fields).toContainEqual(["uuid", id(1)]);
  expect(sections[1]!.fields).toContainEqual(["attention", "blocked: Need approval"]);
  expect(sections[2]!.text).toBe("#5 Clarify empty inbox\nUnblocks: #2 Export task history");
  expect(sections[3]!.fields![0]).toEqual(["link", "sample/repo #105", pr.url]);
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
