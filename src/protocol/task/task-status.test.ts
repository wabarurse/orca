import { expect, test } from "bun:test";
import { canonicalTask, publicTaskStatus } from "./task-ledger";
import type { Task } from "./tasks";
const task = (): Task => ({ id: crypto.randomUUID(), number: 1, name: "Task", summary: "", branch: "feat/task", status: "queued", createdAt: "today", updatedAt: "today", revision: 1, runs: [], history: [] });
const pr = { repository: "sample/repo", number: 1, url: "https://github.com/sample/repo/pull/1", head: "a".repeat(40) };
test("current task states include closed separately from waiting and merged", () => {
  const t = task(); expect(publicTaskStatus(t)).toBe("queued");
  t.status = "working"; expect(publicTaskStatus(t)).toBe("working");
  t.status = "reviewing"; expect(publicTaskStatus(t)).toBe("working");
  t.status = "ready_to_merge"; expect(publicTaskStatus(t)).toBe("waiting");
  t.attention = { kind: "waiting", reason: "Decision needed" }; expect(publicTaskStatus(t)).toBe("waiting");
  t.pr = pr; t.publication = { pr, state: "OPEN", observedAt: "today" }; expect(publicTaskStatus(t)).toBe("pr open");
  t.archive = { reason: "merged", mergedAt: "today", archivedAt: "today", pr }; expect(publicTaskStatus(t)).toBe("merged");
});
test("open PR wins over every hold reason without changing the reason or stored checkpoints", () => {
  for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
    const t = task(); t.status = "working"; t.pr = pr; t.publication = { pr, state: "OPEN", observedAt: "today" }; t.attention = { kind, reason: "Preserve this reason" };
    const before = JSON.stringify(t); expect(publicTaskStatus(t)).toBe("pr open"); expect(JSON.stringify(t)).toBe(before);
    expect(canonicalTask(t).status).toBe("pr open"); // Existing checkpoint storage stays compatible and unchanged.
    delete t.publication; expect(publicTaskStatus(t)).toBe(kind === "closed" || kind === "cancelled" ? "closed" : "waiting");
  }
});
test("a link or historical checkpoint cannot prove an open PR; closing and reopening update the label", () => {
  const t = task(); t.pr = pr; t.checkpoints = { prOpenAt: "yesterday" };
  expect(publicTaskStatus(t)).toBe("queued");
  t.publication = { pr, state: "OPEN", observedAt: "today" }; expect(publicTaskStatus(t)).toBe("pr open");
  t.publication.state = "CLOSED"; expect(publicTaskStatus(t)).toBe("closed");
  t.publication.state = "OPEN"; expect(publicTaskStatus(t)).toBe("pr open");
});
test("active workers and reviewers are working, but prepared and ended runs do not start queued tasks", () => {
  for (const role of ["worker", "reviewer"] as const) {
    const t = task(); t.runs = [{ id: "r", agent: "agent", role, state: "prepared", preparedAt: "today" }];
    expect(publicTaskStatus(t)).toBe("queued");
    t.runs[0]!.state = "started"; expect(publicTaskStatus(t)).toBe("working");
    t.runs[0]!.endedAt = "today"; expect(publicTaskStatus(t)).toBe("queued");
  }
});
