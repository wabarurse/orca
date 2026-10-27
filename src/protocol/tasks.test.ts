import { expect, test } from "bun:test";
import { taskPublicationView, type Task, type TaskPublicationEvidence, type PRObservation } from "./tasks";

const now = "2026-01-01T00:00:00.000Z";
const pr = { repository: "o/r", number: 12, url: "https://github.com/o/r/pull/12", head: "a".repeat(40) };
const task = (): Task => ({
  id: "11111111-1111-4111-8111-111111111111", name: "Publish", summary: "summary", branch: "feat/publish",
  status: "reviewing", revision: 7, createdAt: now, updatedAt: now, pr: { ...pr },
  runs: [{ id: "worker-run", agent: "worker", role: "worker", state: "stopped", preparedAt: now, endedAt: now }],
  attention: { kind: "blocked", reason: "conflicting" }, history: [],
});
const evidence = (t: Task, changes: Partial<PRObservation> = {}): TaskPublicationEvidence => ({
  taskId: t.id, revision: t.revision,
  observation: { pr: { ...pr }, branch: t.branch, state: "OPEN", ready: false, checks: "failed", mergeable: "conflicting", ...changes },
});

test("OPEN publication is independent of readiness, checks, conflicts and attention", () => {
  for (const checks of ["passed", "not_configured", "pending", "failed", "unknown"] as const) {
    for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
      const t = task(); t.attention = { kind, reason: "retained" };
      const before = structuredClone(t), view = taskPublicationView(t, evidence(t, { checks }));
      expect(view.milestone).toEqual({ kind: "published", label: "PR is out", tone: "green", pr });
      expect(view.attention).toEqual(t.attention);
      expect(view.source).toEqual(before);
      expect(view.source.runs[0]?.state).toBe("stopped");
      expect(view.source.readiness).toBeUndefined();
      expect(t).toEqual(before);
    }
  }
});

test("existing ready records and validation history remain detached and intact", () => {
  const t = task(); t.status = "ready_to_merge";
  t.readiness = { head: pr.head, run: "review-run", validatedAt: now, validation: "targeted tests passed", checks: "passed" };
  t.history = [{ revision: 7, at: now, kind: "ready", status: t.status, run: "review-run", pr, readiness: t.readiness }];
  const before = structuredClone(t), view = taskPublicationView(t, evidence(t));
  expect(view.id).toBe(t.id); expect(view.revision).toBe(7);
  expect(view.source).toEqual(before);
  expect(view.milestone.kind).toBe("published");
  expect(taskPublicationView(t).milestone.kind).toBe("unknown");
  view.source.history[0]!.readiness!.validation = "changed";
  view.source.runs[0]!.id = "changed";
  if (view.milestone.kind === "published") view.milestone.pr.head = "b".repeat(40);
  expect(t).toEqual(before);
});

test("closed is neutral; only durable verified merge archive is purple", () => {
  const t = task();
  expect(taskPublicationView(t, evidence(t, { state: "CLOSED" })).milestone).toEqual({ kind: "closed", label: "PR closed", tone: "neutral", pr });
  expect(taskPublicationView(t, evidence(t, { state: "MERGED", mergedAt: now })).milestone.kind).toBe("unknown");
  t.archive = { reason: "merged", pr, mergedAt: now, archivedAt: now };
  const view = taskPublicationView(t, evidence(t));
  expect(view.milestone).toEqual({ kind: "merged", label: "merged", tone: "purple", pr, mergedAt: now, archivedAt: now });
  expect(view.attention).toEqual(t.attention);
});

test("absent, failed, stale and mismatched evidence cannot fabricate verification", () => {
  const t = task(), good = evidence(t);
  const invalid: (TaskPublicationEvidence | null | undefined)[] = [undefined, null,
    { ...good, taskId: "another-task" }, { ...good, revision: 6 },
    evidence(t, { branch: "another-branch" }),
    ...[{ repository: "other/repo" }, { number: 13 }, { url: "https://github.com/o/r/pull/13" }, { head: "b".repeat(40) }]
      .map(change => evidence(t, { pr: { ...pr, ...change } })),
  ];
  for (const e of invalid) expect(taskPublicationView(t, e).milestone).toEqual({ kind: "unknown", tone: "neutral" });
  delete t.pr;
  expect(taskPublicationView(t, good).milestone.kind).toBe("unknown");
});
