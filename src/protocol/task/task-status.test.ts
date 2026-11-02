import { expect, test } from "bun:test";
import { canonicalTask, publicTaskStatus } from "./task-ledger";
import type { Task } from "./tasks";
const task = (): Task => ({ id: crypto.randomUUID(), number: 1, name: "Task", summary: "", branch: "feat/task", status: "queued", createdAt: "today", updatedAt: "today", revision: 1, runs: [], history: [] });
const pr = { repository: "sample/repo", number: 1, url: "https://github.com/sample/repo/pull/1", head: "a".repeat(40) };
test("current task states are exactly queued, working, reviewing, ready to merge, merged and waiting", () => {
  const t = task(); expect(publicTaskStatus(t)).toBe("queued");
  t.status = "working"; expect(publicTaskStatus(t)).toBe("working");
  t.status = "reviewing"; expect(publicTaskStatus(t)).toBe("reviewing");
  t.status = "ready_to_merge"; expect(publicTaskStatus(t)).toBe("ready to merge");
  t.attention = { kind: "waiting", reason: "Decision needed" }; expect(publicTaskStatus(t)).toBe("waiting");
  t.archive = { reason: "merged", mergedAt: "today", archivedAt: "today", pr }; expect(publicTaskStatus(t)).toBe("merged");
});
test("all hold reasons map to waiting, regardless of published PR history, and retain their details", () => {
  for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
    const t = task(); t.status = "working"; t.pr = pr; t.publication = { pr, state: "OPEN", observedAt: "today" }; t.attention = { kind, reason: "Preserve this reason" };
    const before = JSON.stringify(t); expect(publicTaskStatus(t)).toBe("waiting"); expect(JSON.stringify(t)).toBe(before);
    expect(canonicalTask(t).status).toBe("pr open"); // Existing checkpoint storage stays compatible and unchanged.
  }
});
test("a closed PR waits; publication alone never implies ready to merge", () => {
  const t = task(); t.pr = pr; t.publication = { pr, state: "OPEN", observedAt: "today" };
  expect(publicTaskStatus(t)).toBe("queued");
  t.publication.state = "CLOSED"; expect(publicTaskStatus(t)).toBe("waiting");
});
