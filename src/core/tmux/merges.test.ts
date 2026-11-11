import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { getTask, observeTaskPR, prepareTaskRun, registerTask, startTaskRun, setTaskAttention } from "../data/tasks";
import { observe, flushObservations } from "../data/inbox";
import { mergeWatcher } from "./merges";
import type { PRObservation } from "../../protocol/task";
let root: string, previous: string | undefined;
const project = "p", head = "a".repeat(40);
const observation = (state: PRObservation["state"] = "MERGED"): PRObservation => ({
  pr: { repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head }, branch: "feat/work", state,
  ...(state === "MERGED" ? { mergedAt: "2026-10-30T15:00:00Z" } : {}), ready: false, checks: "unknown",
});
beforeEach(() => { previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-merge-notify-")); process.env.ORCA_HOME = root; mkdirSync(paths.project(project), { recursive: true }); });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
async function linked() {
  const task = await registerTask(project, { name: "Work", summary: "Requested change", branch: "feat/work", authorized: true });
  return observeTaskPR(project, task.id, observation("OPEN"));
}
const messages = () => existsSync(join(paths.inbox(project), "orchestrator")) ? readdirSync(join(paths.inbox(project), "orchestrator")).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(paths.inbox(project), "orchestrator", n), "utf8"))) : [];
test("merge notification updates the task once and preserves active ownership, files and branches", async () => {
  const task = await linked();
  await prepareTaskRun(project, task.id, task.branch, { id: "running", role: "worker", agent: "worker-feat-work" }); await startTaskRun(project, "running");
  const workspace = join(root, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "draft"), "keep");
  let queries = 0;
  const opts = { repo: async () => "o/r", pr: async () => { queries++; return observation(); }, everyMs: 0 };
  expect(await mergeWatcher(opts)(project)).toEqual([7]);
  expect((await getTask(project, task.id)).archive?.reason).toBe("merged");
  expect((await getTask(project, task.id)).runs.at(-1)?.state).toBe("started");
  expect(readFileSync(join(workspace, "draft"), "utf8")).toBe("keep");
  expect(messages()).toHaveLength(1); expect(messages()[0].text).toContain("[pr-merged]");
  expect(await mergeWatcher(opts)(project)).toEqual([]); // separate process/client equivalent
  expect(messages()).toHaveLength(1); expect(queries).toBe(1);
  expect(existsSync(`${paths.transcript(project, "worker-feat-work")}.cancel`)).toBe(false);
});
test("an archived task drains a notification missed between archive and delivery", async () => {
  const task = await linked();
  await observe(project, "merge:o/r#7", observation().mergedAt, "[pr-merged] observed merge", { defer: true });
  await observeTaskPR(project, task.id, observation());
  await mergeWatcher({ repo: async () => "o/r", pr: async () => { throw Error("must not re-query archived PR"); } })(project);
  expect(messages()).toHaveLength(1);
});
test("conversations with no linked PRs perform no remote queries", async () => {
  let calls = 0; await mergeWatcher({ repo: async () => { calls++; return "o/r"; } })(project); expect(calls).toBe(0);
});
test("unknown, closed and foreign/mismatched observations never claim a merge", async () => {
  const task = await linked();
  for (const result of [null, observation("CLOSED"), { ...observation(), branch: "other" }]) {
    await mergeWatcher({ repo: async () => "o/r", pr: async () => result })(project).catch(() => {});
    expect((await getTask(project, task.id)).archive).toBeUndefined();
  }
  await mergeWatcher({ repo: async () => "other/repo", pr: async () => { throw Error("foreign query"); } })(project);
  expect((await getTask(project, task.id)).archive).toBeUndefined();
});
test("watcher coalesces overlapping checks and respects its polling interval", async () => {
  await linked(); let calls = 0, now = 0;
  const gate = Promise.withResolvers<PRObservation>();
  const check = mergeWatcher({ now: () => now, everyMs: 30_000, repo: async () => "o/r", pr: async () => { calls++; return gate.promise; } });
  const first = check(project); await Bun.sleep(15); expect(await check(project)).toEqual([]);
  gate.resolve(observation("OPEN")); await first; expect(calls).toBe(1);
  now = 29_999; await check(project); expect(calls).toBe(1);
  now = 30_000; await check(project); expect(calls).toBe(2);
});

test("historical merged tasks are retained without replaying old merge notifications", async () => {
  const task = await linked(); await observeTaskPR(project, task.id, observation());
  expect(await mergeWatcher({ repo: async () => "o/r" })(project)).toEqual([]);
  expect(existsSync(join(paths.inbox(project), "orchestrator"))).toBe(false);
});

test("closed PRs, new commits, CI and review changes notify once across observer restarts", async () => {
  const task = await linked();
  let current: PRObservation = { ...observation("OPEN"), checks: "pending", reviewDecision: "REVIEW_REQUIRED" };
  const poll = () => mergeWatcher({ repo: async () => "o/r", pr: async () => current, everyMs: 0 })(project);
  await poll(); // Initial pending/open baseline is silent.
  expect(existsSync(join(paths.inbox(project), "orchestrator"))).toBe(false);
  current = { ...current, checks: "passed" };
  await poll(); await poll(); expect(messages()).toHaveLength(1);
  current = { ...current, pr: { ...current.pr, head: "b".repeat(40) }, checks: "pending" };
  await poll(); expect(messages()).toHaveLength(2);
  current = { ...current, reviewDecision: "CHANGES_REQUESTED" };
  await poll(); expect(messages()).toHaveLength(3);
  current = { ...current, reviewActivity: "new-review-comment" };
  await poll(); expect(messages()).toHaveLength(4);
  current = { ...current, state: "CLOSED" };
  await poll(); await poll(); expect(messages()).toHaveLength(5);
  expect(messages().some(m => m.text.includes("[pr-closed]"))).toBe(true);
  expect((await getTask(project, task.id)).attention?.kind).toBe("closed");
  expect((await getTask(project, task.id)).archive).toBeUndefined();
});

test("project-owned watches need no task or worker and coalesce with linked task PRs", async () => {
  const { registerPRWatch, readProcess } = await import("../data/processes");
  const handle = await registerPRWatch(project, { repository: "o/r", number: 7, head });
  let calls = 0;
  const poll = (state: PRObservation["state"]) => mergeWatcher({ repo: async () => "o/r", pr: async () => { calls++; return observation(state); }, everyMs: 0 })(project);
  await poll("OPEN"); expect(calls).toBe(1);
  expect(messages()).toHaveLength(0); // Registration establishes a silent baseline.
  await linked(); await poll("CLOSED"); expect(calls).toBe(2);
  expect(messages()).toHaveLength(1);
  expect((await readProcess(project, handle.process)).state).toBe("exited");
  await poll("CLOSED"); expect(calls).toBe(2);
});

test("stopping a watch prevents late notifications and task polling until explicit registration", async () => {
  const { registerPRWatch, controlProcess } = await import("../data/processes");
  await linked();
  const handle = await registerPRWatch(project, { repository: "o/r", number: 7, head });
  const gate = Promise.withResolvers<PRObservation>();
  let calls = 0;
  const poll = mergeWatcher({ repo: async () => "o/r", pr: async () => { calls++; return gate.promise; }, everyMs: 0 });
  const running = poll(project);
  for (let i = 0; calls === 0 && i < 100; i++) await Bun.sleep(5);
  await controlProcess(project, handle.process, "stop");
  const { processTool } = await import("../tools/process");
  await processTool.run({ action: "forget", id: handle.process }, { project, role: "orchestrator", cwd: root });
  gate.resolve(observation("CLOSED")); await running;
  expect(existsSync(join(paths.inbox(project), "orchestrator"))).toBe(false);
  await poll(project); expect(calls).toBe(1);
  await registerPRWatch(project, { repository: "o/r", number: 7, head });
  await poll(project); expect(calls).toBe(2); expect(messages()).toHaveLength(1);
});

test("Ctrl+C fences an in-flight PR observation and does not publish or restart work", async () => {
  const { execution } = await import("../data/projects/lifecycle");
  const task = await linked(), gate = Promise.withResolvers<PRObservation>();
  let called = false;
  const poll = mergeWatcher({ repo: async () => "o/r", pr: async () => { called = true; return gate.promise; } });
  const pending = poll(project);
  for (let i = 0; !called && i < 100; i++) await Bun.sleep(5);
  await execution.stop(project);
  gate.resolve(observation("CLOSED"));
  await expect(pending).rejects.toThrow("stopped");
  expect((await getTask(project, task.id)).attention).toBeUndefined();
  expect(existsSync(join(paths.inbox(project), "orchestrator"))).toBe(false);
  expect(await poll(project)).toEqual([]);
});

test("mergeability flapping at the same head is silent, including across restarts and old persisted snapshots", async () => {
  await linked();
  const current = { ...observation("OPEN"), checks: "failed" as const, reviewDecision: "APPROVED" as const, reviewActivity: "same-review", mergeable: "conflicting" as const };
  // The exact schema emitted by the previous installed watcher.
  await observe(project, "pr:o/r#7", { state: "OPEN", head, checks: "failed", review: "APPROVED", reviewActivity: "same-review", mergeable: "conflicting" }, "previous snapshot", { initialSilent: true });
  for (const mergeable of ["unknown", "conflicting", "unknown", "conflicting", "unknown", "conflicting"] as const) {
    await mergeWatcher({ repo: async () => "o/r", pr: async () => ({ ...current, mergeable }), everyMs: 0 })(project);
  }
  expect(messages()).toEqual([]);
  await mergeWatcher({ repo: async () => "o/r", pr: async () => ({ ...current, mergeable: "mergeable" }), everyMs: 0 })(project);
  expect(messages()).toHaveLength(1); // A confirmed conflict resolution still matters.
});

test("initial failed checks are a baseline, but a new commit, CI result and review still notify", async () => {
  await linked();
  let current: PRObservation = { ...observation("OPEN"), checks: "failed", reviewDecision: "REVIEW_REQUIRED", reviewActivity: "review-1", mergeable: "mergeable" };
  const poll = () => mergeWatcher({ repo: async () => "o/r", pr: async () => current, everyMs: 0 })(project);
  await poll(); expect(messages()).toEqual([]);
  current = { ...current, pr: { ...current.pr, head: "b".repeat(40) }, mergeable: "unknown" };
  await poll(); expect(messages()).toHaveLength(1);
  current = { ...current, checks: "passed", mergeable: "mergeable" };
  await poll(); expect(messages()).toHaveLength(2);
  current = { ...current, checks: "unknown", reviewDecision: undefined, reviewActivity: undefined, mergeable: "unknown" };
  await poll(); expect(messages()).toHaveLength(2);
  current = { ...current, checks: "passed", reviewDecision: "REVIEW_REQUIRED", reviewActivity: "review-1", mergeable: "mergeable" };
  await poll(); expect(messages()).toHaveLength(2);
  current = { ...current, reviewActivity: "review-2" };
  await poll(); expect(messages()).toHaveLength(3);
});

test("cancelled tasks stop automatic and explicit watches without querying GitHub or changing their cancellation", async () => {
  const { registerPRWatch, readProcess } = await import("../data/processes");
  const task = await linked(), handle = await registerPRWatch(project, { repository: "o/r", number: 7, head });
  await setTaskAttention(project, task.id, { kind: "cancelled", reason: "user stopped this work" });
  let calls = 0;
  await mergeWatcher({ repo: async () => "o/r", pr: async () => { calls++; return observation("OPEN"); } })(project);
  expect(calls).toBe(0); expect(messages()).toEqual([]);
  expect((await readProcess(project, handle.process)).state).toBe("exited");
  expect((await getTask(project, task.id)).attention?.kind).toBe("cancelled");
});

test("cancelling a task while the remote query is in flight suppresses its notification", async () => {
  const task = await linked(), gate = Promise.withResolvers<PRObservation>();
  let called = false;
  const running = mergeWatcher({ repo: async () => "o/r", pr: async () => { called = true; return gate.promise; } })(project);
  for (let i = 0; !called && i < 100; i++) await Bun.sleep(5);
  await setTaskAttention(project, task.id, { kind: "cancelled", reason: "user stopped this work" });
  gate.resolve(observation("CLOSED")); await running;
  expect(messages()).toEqual([]);
  expect((await getTask(project, task.id)).attention?.kind).toBe("cancelled");
});

test("several changed PRs enter the orchestrator inbox as one durable batch", async () => {
  await linked();
  const other = await registerTask(project, { name: "Other", summary: "Independent work", branch: "feat/other", authorized: true });
  const second = { ...observation("OPEN"), branch: "feat/other", pr: { ...observation().pr, number: 8, url: "https://github.com/o/r/pull/8" } };
  await observeTaskPR(project, other.id, second);
  const poll = (checks: PRObservation["checks"]) => mergeWatcher({ everyMs: 0, repo: async () => "o/r", pr: async (_, pr) => ({ ...(pr.number === 7 ? observation("OPEN") : second), checks }) })(project);
  await poll("pending"); expect(messages()).toEqual([]);
  await poll("passed");
  expect(messages()).toHaveLength(1);
  expect(messages()[0].text).toContain("PR #7"); expect(messages()[0].text).toContain("PR #8");
  await poll("passed"); expect(messages()).toHaveLength(1);
});

test("a failed batch delivery survives restart with the same identity", async () => {
  await observe(project, "pr:o/r#7", "changed", "PR changed", { defer: true });
  let checks = 0;
  await expect(flushObservations(project, ["pr:o/r#7"], () => { if (++checks === 2) throw Error("interrupted delivery"); })).rejects.toThrow("interrupted");
  const path = join(paths.runtimeProject(project), "observations", "batch.json"), journal = readFileSync(path, "utf8");
  const id = JSON.parse(journal).message.event.id;
  await flushObservations(project, [], () => {});
  expect(messages()).toHaveLength(1); expect(messages()[0].event.id).toBe(id);
  // Reproduce a crash after inbox publication but before journal removal.
  writeFileSync(path, journal);
  await flushObservations(project, [], () => {});
  expect(messages()).toHaveLength(1); expect(messages()[0].event.id).toBe(id);
  expect(existsSync(path)).toBe(false);
});

test("batch recovery drops observations for work cancelled since the delivery failure", async () => {
  const task = await linked();
  await observe(project, "pr:o/r#7", "changed", "PR changed", { defer: true });
  let checks = 0;
  await expect(flushObservations(project, ["pr:o/r#7"], () => { if (++checks === 2) throw Error("interrupted"); })).rejects.toThrow("interrupted");
  await setTaskAttention(project, task.id, { kind: "cancelled", reason: "user stopped this work" });
  await mergeWatcher({ repo: async () => "o/r", pr: async () => { throw Error("cancelled PR must not be queried"); } })(project);
  expect(messages()).toEqual([]);
  expect(existsSync(join(paths.runtimeProject(project), "observations", "batch.json"))).toBe(false);
});

test("a cancellation during another PR's query removes the staged update from the final batch", async () => {
  const task = await linked();
  const other = await registerTask(project, { name: "Other", summary: "Independent work", branch: "feat/other", authorized: true });
  const second = { ...observation("OPEN"), branch: "feat/other", pr: { ...observation().pr, number: 8, url: "https://github.com/o/r/pull/8" } };
  await observeTaskPR(project, other.id, second);
  await mergeWatcher({ repo: async () => "o/r", pr: async (_, pr) => {
    if (pr.number === 8) await setTaskAttention(project, task.id, { kind: "cancelled", reason: "user stopped this work" });
    return { ...(pr.number === 7 ? observation("OPEN") : second), pr: { ...(pr.number === 7 ? observation().pr : second.pr), head: "b".repeat(40) } };
  } })(project);
  expect(messages()).toHaveLength(1);
  expect(messages()[0].text).not.toContain("PR #7"); expect(messages()[0].text).toContain("PR #8");
});
