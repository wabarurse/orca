import { expect, test } from "bun:test";
import { taskPublicationView, taskPublicationObservation, type Task } from "./tasks";
const now = "2026-01-01T00:00:00.000Z";
const pr = { repository: "o/r", number: 12, url: "https://github.com/o/r/pull/12", head: "a".repeat(40) };
const task = (): Task => ({
  id: "11111111-1111-4111-8111-111111111111", name: "Publish", summary: "summary", branch: "feat/publish",
  status: "reviewing", revision: 7, createdAt: now, updatedAt: now, pr: { ...pr },
  publication: { pr: { ...pr }, state: "OPEN", observedAt: now },
  runs: [{ id: "worker-run", agent: "worker", role: "worker", state: "stopped", preparedAt: now, endedAt: now }],
  attention: { kind: "blocked", reason: "conflicting" }, history: [],
});
test("publication retains independent attention, stopped identity and unrelated revisions", () => {
  for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
    const t = task(); t.attention = { kind, reason: "retained" }; t.revision++;
    const before = structuredClone(t), view = taskPublicationView(t);
    expect(view.milestone).toEqual({ kind: "published", label: "PR is out", tone: "green", pr, observedAt: now });
    expect(view.attention).toEqual({ kind, reason: "retained" });
    expect(view.source).toEqual(before); expect(view.id).toBe(t.id); expect(view.revision).toBe(8);
    expect(view.source.runs[0]?.id).toBe("worker-run"); expect(view.source.runs[0]?.state).toBe("stopped");
    expect(view.source.readiness).toBeUndefined(); expect(t).toEqual(before);
  }
});
test("ready validation and history stay detached; legacy readiness cannot fabricate publication", () => {
  const t = task(); t.status = "ready_to_merge"; delete t.attention;
  t.readiness = { head: pr.head, run: "review-run", validatedAt: now, validation: "targeted tests passed", checks: "passed" };
  t.history = [{ revision: 7, at: now, kind: "ready", status: t.status, run: "review-run", pr, readiness: t.readiness }];
  const before = structuredClone(t), view = taskPublicationView(t);
  expect(view.source).toEqual(before); expect(view.milestone.kind).toBe("published");
  view.source.history[0]!.readiness!.validation = "changed";
  if (view.milestone.kind === "published") view.milestone.pr.head = "b".repeat(40);
  expect(t).toEqual(before);
  delete t.publication; expect(taskPublicationView(t).milestone.kind).toBe("unknown");
});
test("closed is neutral, archive wins, historical same-PR head remains valid", () => {
  const t = task(); t.pr!.head = "b".repeat(40);
  expect(taskPublicationView(t).milestone.kind).toBe("published");
  t.publication!.state = "CLOSED";
  expect(taskPublicationView(t).milestone).toEqual({ kind: "closed", label: "PR closed", tone: "neutral", pr, observedAt: now });
  t.archive = { reason: "merged", pr: t.pr!, mergedAt: now, archivedAt: now };
  expect(taskPublicationView(t).milestone).toEqual({ kind: "merged", label: "merged", tone: "purple", pr: t.pr!, mergedAt: now, archivedAt: now });
  expect(taskPublicationView(t).attention).toEqual({ kind: "blocked", reason: "conflicting" });
});
test("malformed or cross-PR proof fails closed", () => {
  const proof = task().publication!;
  for (const raw of [null, {}, { ...proof, state: "MERGED" }, { ...proof, observedAt: "bad" },
    { ...proof, pr: { ...pr, head: "bad" } }, { ...proof, pr: { ...pr, url: "https://other" } },
    { ...proof, pr: { ...pr, repository: "O/R" } }]) expect(() => taskPublicationObservation(raw, pr)).toThrow();
  expect(() => taskPublicationObservation(proof, undefined)).toThrow("mismatch");
  expect(() => taskPublicationObservation(proof, { ...pr, number: 13 })).toThrow("mismatch");
});
