import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config/config";
import { allTasks, archiveMergedTasks, blockConflictingTask, getTask, invalidateTaskBranch, listTasks, observeTaskPR, prepareTaskRun, registerTask, setTaskAttention, startTaskRun, stopTaskRun, validateTaskReadiness } from "./tasks";
import { taskPR, taskStatusLabels, type PRObservation, type Task } from "../../../protocol/tasks";
import { beginRun, recoverTaskRuns, supervise } from "../../tmux/exits";
import { afterExit } from "../../../exec/after-exit";
import { cancelSession, Cancelled, publishLaunch } from "../../tmux/cancellation";
import { makeSpawn } from "../../tools/spawn";
import { withProjectStateLock } from "../projects/state";
import { ask, list as questions } from "../inbox/questions";
import { pending, put } from "../inbox/inbox";

const home = mkdtempSync(join(tmpdir(), "task-registry-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
let n = 0, project: string;
beforeEach(() => { project = `task-${n++}`; mkdirSync(paths.project(project), { recursive: true }); });
const input = (branch = "feat/x") => ({ name: "Task name", summary: "A presentation summary", branch, authorized: true as const });
const observation = (head = "a".repeat(40)): PRObservation => ({ pr: { repository: "o/r", number: 3, url: "https://github.com/o/r/pull/3", head }, branch: "feat/x", state: "OPEN", ready: true, checks: "not_configured" });
const prepare = (t: Task, id: string, role: "worker" | "reviewer" = "worker") => prepareTaskRun(project, t.id, t.branch, { id, agent: `${role}-feat-x`, role });
async function reviewing() {
  const t = await registerTask(project, input());
  await prepare(t, "worker"); await startTaskRun(project, "worker"); await stopTaskRun(project, "worker", "waiting", "Reported");
  await prepare(t, "reviewer", "reviewer"); await startTaskRun(project, "reviewer");
  await observeTaskPR(project, t.id, observation()); return getTask(project, t.id);
}
async function ready() {
  const t = await reviewing();
  return validateTaskReadiness(project, t.id, { run: "reviewer", revision: t.revision, observation: observation(), validated: true, validation: "Local tests, build and review passed for this head" });
}
const info = (run: string) => ({ project, id: "worker-feat-x", branch: "feat/x", role: "worker" as const, run, cwd: home });

test("versioned persistence, stable UUIDs, narrow typed rows and project isolation", async () => {
  const t = await registerTask(project, input());
  expect(t.status).toBe("queued"); expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await registerTask(project, { ...input(), id: t.id })).toEqual(t);
  await expect(registerTask(project, { ...input(), id: t.id, name: "Different task" })).rejects.toThrow("different fields");
  expect(await getTask(project, t.id)).toEqual(t);
  expect(await listTasks("another-project")).toEqual([]);
  expect(Object.keys((await listTasks(project))[0]!).sort()).toEqual(["id", "name", "summary", "branch", "status", "createdAt", "updatedAt", "review"].sort());
  expect(JSON.parse(readFileSync(join(paths.project(project), "tasks.json"), "utf8")).version).toBe(1);
  expect(taskStatusLabels.ready_to_merge).toBe("ready to merge");
});

test("schema rejects unauthorized work, unsafe fields, corrupt versions/status/readiness and never overwrites corruption", async () => {
  await expect(registerTask(project, { ...input(), authorized: false as true })).rejects.toThrow("authorization");
  await expect(registerTask("../escape", input())).rejects.toThrow("project");
  await expect(registerTask(project, { ...input(), id: "../escape" })).rejects.toThrow("id");
  await expect(registerTask(project, { ...input(), name: "\x1b]8;bad" })).rejects.toThrow("control");
  await expect(registerTask(project, { ...input(), summary: "x".repeat(501) })).rejects.toThrow("500");
  await expect(registerTask(project, { ...input(), branch: "../other" })).rejects.toThrow("branch");
  const t = await registerTask(project, input()), path = join(paths.project(project), "tasks.json");
  const originals = { version: 1, tasks: [t] };
  for (const corrupt of [{ ...originals, version: 99 }, { version: 1, tasks: [{ ...t, status: "completed" }] }, { version: 1, tasks: [{ ...t, status: "ready_to_merge" }] }, { version: 1, tasks: [t, t] }, { version: 1, tasks: [{ ...t, runs: [{}] }] }]) {
    const bytes = JSON.stringify(corrupt); writeFileSync(path, bytes);
    await expect(allTasks(project)).rejects.toThrow();
    await expect(registerTask(project, input())).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }
});

test("PR URLs are canonical identity-matched HTTPS GitHub links, not arbitrary terminal links", () => {
  const good = observation().pr;
  expect(taskPR({ ...good, repository: "O/R", url: "https://github.com/O/R/pull/3" })).toEqual(good);
  for (const url of ["javascript:alert(1)", "https://evil.com/o/r/pull/3", "https://github.com/o/other/pull/3", "https://github.com/o/r/pull/4", good.url + "?x", "https://github.com@evil.com/o/r/pull/3", good.url + "\x1b", "http://github.com/o/r/pull/3"]) expect(() => taskPR({ ...good, url })).toThrow();
  expect(() => taskPR({ ...good, number: -1 })).toThrow(); expect(() => taskPR({ ...good, head: "main" })).toThrow();
});

test("same-task retries/reviewer handoffs keep ID; separate task on reusable branch does not overwrite earlier one", async () => {
  const first = await registerTask(project, input());
  await prepare(first, "one"); expect((await getTask(project, first.id)).status).toBe("queued");
  await startTaskRun(project, "one"); await stopTaskRun(project, "one", "blocked", "Need correction");
  await prepare(first, "two"); await startTaskRun(project, "two"); await stopTaskRun(project, "two", "waiting", "Reported");
  await prepare(first, "review", "reviewer");
  expect((await getTask(project, first.id)).status).toBe("reviewing"); // includes zero-code-review watch-ci handoff
  await startTaskRun(project, "review"); await stopTaskRun(project, "review", "waiting", "Reviewed");
  const second = await registerTask(project, { ...input(), summary: "Separate follow-up" });
  await prepare(second, "follow-up"); await startTaskRun(project, "follow-up");
  await stopTaskRun(project, "one", "cancelled", "Late old event");
  expect(second.id).not.toBe(first.id);
  expect((await getTask(project, first.id)).runs.map(r => r.id)).toEqual(["one", "two", "review"]);
  expect((await getTask(project, second.id)).status).toBe("working"); expect(await listTasks(project)).toHaveLength(2);
});

test("spawn requires queued task, never treats runner return as a started worker, and actual supervisor starts it", async () => {
  let run = "", starts = 0;
  const tool = makeSpawn({ async running() { return []; }, async start(o) { starts++; run = o.run!; }, async stop() {} });
  const ctx = { project, role: "orchestrator" as const, cwd: home };
  expect(await tool.run({ branch: "feat/x", prompt: "do it" }, ctx)).toContain("taskId");
  const t = await registerTask(project, input());
  await tool.run({ taskId: t.id, branch: t.branch, prompt: "do it" }, ctx);
  expect(starts).toBe(1); expect((await getTask(project, t.id)).status).toBe("queued");
  await beginRun(info(run), 12345);
  expect((await getTask(project, t.id)).status).toBe("working");
  expect((await getTask(project, t.id)).runs[0]?.state).toBe("started");
});

test("failed launches and failed persistence cannot fabricate working or dispatch a process", async () => {
  const t = await registerTask(project, input()); let starts = 0;
  const tool = makeSpawn({ async running() { return []; }, async start() { starts++; throw new Error("tmux unavailable"); }, async stop() {} });
  const ctx = { project, role: "orchestrator" as const, cwd: home };
  await expect(tool.run({ taskId: t.id, branch: t.branch, prompt: "do it" }, ctx)).rejects.toThrow("tmux");
  const failed = await getTask(project, t.id);
  expect(failed.status).toBe("queued"); expect(failed.runs[0]?.state).toBe("failed"); expect(failed.attention?.kind).toBe("blocked");
  const before = readFileSync(join(paths.project(project), "tasks.json"), "utf8");
  // A directory at the final filename makes read/write fail closed, without touching user data.
  rmSync(join(paths.project(project), "tasks.json")); mkdirSync(join(paths.project(project), "tasks.json"));
  await expect(tool.run({ taskId: t.id, branch: t.branch, prompt: "retry" }, ctx)).rejects.toThrow();
  expect(starts).toBe(1);
  rmSync(join(paths.project(project), "tasks.json"), { recursive: true }); writeFileSync(join(paths.project(project), "tasks.json"), before);
  expect(await getTask(project, t.id)).toEqual(failed);
});

test("PR creation, absence of CI, normal report and process exit never imply readiness", async () => {
  const t = await reviewing(); expect(t.status).toBe("reviewing"); expect(t.readiness).toBeUndefined();
  const args = { run: "reviewer", revision: t.revision, observation: observation(), validated: true as const, validation: "" };
  await expect(validateTaskReadiness(project, t.id, args)).rejects.toThrow("validation");
  await expect(validateTaskReadiness(project, t.id, { ...args, validation: "Local checks passed", validated: false as true })).rejects.toThrow("validated");
  for (const checks of ["pending", "failed", "unknown"] as const) await expect(validateTaskReadiness(project, t.id, { ...args, validation: "Local checks", observation: { ...observation(), checks } })).rejects.toThrow();
  await stopTaskRun(project, "reviewer", "waiting", "Reported success"); expect((await getTask(project, t.id)).status).toBe("reviewing");
  await afterExit({ ...info("reviewer"), code: 1 }); expect((await getTask(project, t.id)).readiness).toBeUndefined();
});

test("explicit validation is head/revision bound; new changes/runs invalidate readiness", async () => {
  const t = await ready(); expect(t.status).toBe("ready_to_merge"); expect(t.readiness?.head).toBe(observation().pr.head);
  await expect(validateTaskReadiness(project, t.id, { run: "reviewer", revision: t.revision - 1, observation: observation(), validated: true, validation: "Checks passed" })).rejects.toThrow("changed");
  await invalidateTaskBranch(project, "reviewer"); expect((await getTask(project, t.id)).status).toBe("reviewing");
  const current = await getTask(project, t.id);
  await validateTaskReadiness(project, t.id, { run: "reviewer", revision: current.revision, observation: observation(), validated: true, validation: "Revalidated" });
  await stopTaskRun(project, "reviewer", "waiting", "Ready report"); expect((await getTask(project, t.id)).status).toBe("ready_to_merge");
  await prepare(t, "fix"); expect((await getTask(project, t.id)).status).toBe("queued"); expect((await getTask(project, t.id)).readiness).toBeUndefined();
});

test("a conflict found after another merge blocks the task and invalidates readiness once; repeats are no-ops", async () => {
  const t = await ready();
  const reason = "conflicts with main after PR #9 merged; rebase needed";
  const blocked = await blockConflictingTask(project, t.id, reason);
  expect(blocked).toMatchObject({ status: "reviewing", attention: { kind: "blocked", reason } });
  expect(blocked.readiness).toBeUndefined();
  expect(blocked.history.at(-1)).toMatchObject({ kind: "readiness_invalidated", attention: { kind: "blocked", reason } });
  expect(await blockConflictingTask(project, t.id, reason)).toEqual(blocked);
  // The PR observation that follows keeps the block (it only overwrites waiting attention).
  await observeTaskPR(project, t.id, { ...observation(), ready: false, mergeable: "conflicting" });
  expect((await getTask(project, t.id)).attention).toEqual({ kind: "blocked", reason });
  const other = await registerTask(project, input("feat/y"));
  expect((await blockConflictingTask(project, other.id, reason)).history.at(-1)?.kind).toBe("attention");
  await archiveMergedTasks(project, observation().pr, new Date().toISOString());
  await expect(blockConflictingTask(project, t.id, reason)).rejects.toThrow("archived");
});

for (const wasReady of [false, true]) test(`same-PR correction after ${wasReady ? "a ready report" : "CI failure"} reuses the task and branch through spawn and revalidation`, async () => {
  const t = await (wasReady ? ready() : reviewing());
  if (!wasReady) await observeTaskPR(project, t.id, { ...observation(), ready: false, checks: "failed" });
  let busy = true;
  const starts: { branch?: string; run?: string; role: string }[] = [];
  const tool = makeSpawn({ async running() { return busy ? ["reviewer-feat-x"] : []; }, async start(o) { starts.push(o); }, async stop() {} }, { waitMs: 0, pollMs: 1 });
  const ctx = { project, role: "orchestrator" as const, cwd: home };
  const correction = { taskId: t.id, branch: t.branch, prompt: "Fix the existing PR on this branch" };
  const before = await getTask(project, t.id);
  expect(await tool.run(correction, ctx)).toContain("still running");
  expect(starts).toHaveLength(0);
  expect(await getTask(project, t.id)).toEqual(before);
  await stopTaskRun(project, "reviewer", "waiting", "Reported"); busy = false;

  expect(await tool.run(correction, ctx)).toBe("worker-feat-x");
  const resumed = await getTask(project, t.id);
  expect(resumed.pr).toEqual(t.pr);
  expect(resumed.status).toBe("queued");
  expect(resumed.readiness).toBeUndefined();
  expect(resumed.runs.at(-1)?.id).toBe(starts[0]!.run);
  if (wasReady) expect(resumed.history.some(e => e.kind === "readiness_invalidated")).toBe(true);
  await startTaskRun(project, starts[0]!.run!);
  await stopTaskRun(project, starts[0]!.run!, "waiting", "Correction complete");

  expect(await tool.run({ ...correction, role: "reviewer", reviewMode: "watch-ci", prompt: "watch ci; update and validate the same PR" }, ctx)).toBe("reviewer-feat-x");
  const reviewRun = starts[1]!.run!;
  await startTaskRun(project, reviewRun);
  const updatedPR = observation("b".repeat(40));
  const observed = await observeTaskPR(project, t.id, updatedPR);
  const validated = await validateTaskReadiness(project, t.id, { run: reviewRun, revision: observed.revision, observation: updatedPR, validated: true, validation: "Correction reviewed and tests passed on the updated head" });
  expect(validated.status).toBe("ready_to_merge");
  expect(validated.readiness?.head).toBe(updatedPR.pr.head);
  expect(validated.pr).toEqual({ ...t.pr!, head: updatedPR.pr.head });
  expect(starts.map(s => [s.branch, s.role])).toEqual([[t.branch, "worker"], [t.branch, "reviewer"]]);
  expect((await allTasks(project)).map(task => task.id)).toEqual([t.id]);
});

test("remote head or failed check invalidates readiness; duplicate PR polling is idempotent", async () => {
  const t = await ready();
  await observeTaskPR(project, t.id, observation()); expect(await getTask(project, t.id)).toEqual(t);
  const next = await observeTaskPR(project, t.id, observation("b".repeat(40)));
  expect(next.status).toBe("reviewing"); expect(next.readiness).toBeUndefined();
  expect(next.pr?.head).toBe("b".repeat(40));
  const last = await observeTaskPR(project, t.id, observation("b".repeat(40)));
  expect(last).toEqual(next);
});

test("cancel before launch and during work is retained, never auto-completed or resumed by a late startup", async () => {
  const t = await registerTask(project, input()); await prepare(t, "early"); publishLaunch(project, "worker-feat-x", "early");
  await cancelSession(project, "worker-feat-x"); await startTaskRun(project, "early");
  expect((await getTask(project, t.id)).status).toBe("queued"); expect((await getTask(project, t.id)).attention?.kind).toBe("cancelled");
  await prepare(t, "authorized-retry");
  await supervise(info("authorized-retry"), async () => { throw new Cancelled(); }, { signals: () => () => {} });
  expect((await getTask(project, t.id)).status).toBe("working"); expect((await getTask(project, t.id)).attention?.kind).toBe("cancelled");
  expect(await listTasks(project)).toHaveLength(1);
});

test("confirmed matching merges archive but retain records; neither old branch nor PR number alone can archive a newer task", async () => {
  const first = await registerTask(project, input()); const newer = await registerTask(project, input());
  await observeTaskPR(project, first.id, observation());
  await archiveMergedTasks(project, { ...observation().pr, repository: "other/r", url: "https://github.com/other/r/pull/3" }, new Date().toISOString());
  expect(await listTasks(project)).toHaveLength(2);
  const mergedAt = new Date().toISOString();
  await archiveMergedTasks(project, observation().pr, mergedAt); await archiveMergedTasks(project, observation().pr, mergedAt);
  expect((await listTasks(project)).map(t => t.id)).toEqual([newer.id]);
  expect((await getTask(project, first.id)).archive).toMatchObject({ reason: "merged", mergedAt });
  expect((await getTask(project, first.id)).history.filter(e => e.kind === "merged")).toHaveLength(1);
  expect(await allTasks(project)).toHaveLength(2);
  await expect(prepare(first, "late")).rejects.toThrow("archived");
});

test("closed-unmerged PR stays active, and blocked/cancelled attention survives head polling", async () => {
  const t = await reviewing();
  await observeTaskPR(project, t.id, { ...observation(), state: "CLOSED", ready: false });
  expect((await getTask(project, t.id)).attention?.kind).toBe("closed"); expect(await listTasks(project)).toHaveLength(1);
  await setTaskAttention(project, t.id, { kind: "cancelled", reason: "Stop" });
  await observeTaskPR(project, t.id, observation("c".repeat(40)));
  expect((await getTask(project, t.id)).attention?.kind).toBe("cancelled");
});

test("concurrent/duplicate updates serialize without lost history, conflicting dispatches and stale updates fail closed", async () => {
  const id = crypto.randomUUID();
  await Promise.all(Array.from({ length: 12 }, () => registerTask(project, { ...input(), id })));
  expect(await allTasks(project)).toHaveLength(1);
  const t = await getTask(project, id);
  await Promise.all(Array.from({ length: 8 }, () => prepare(t, "same")));
  await Promise.all(Array.from({ length: 8 }, () => startTaskRun(project, "same")));
  expect((await getTask(project, id)).history.map(e => e.kind)).toEqual(["registered", "run_prepared", "run_started"]);
  await expect(prepare(t, "conflict")).rejects.toThrow("still active");
  await expect(observeTaskPR(project, id, observation(), 1)).rejects.toThrow("changed");
  await Promise.all(Array.from({ length: 8 }, () => stopTaskRun(project, "same", "waiting", "Report")));
  expect((await getTask(project, id)).revision).toBe(4);
});

test("separate processes serialize registration and restart sees durable data, ignores abandoned temp files", async () => {
  const module = resolve(import.meta.dir, "tasks.ts"), id = crypto.randomUUID();
  const script = `import { registerTask } from ${JSON.stringify(module)}; await registerTask(${JSON.stringify(project)}, ${JSON.stringify({ ...input(), id })});`;
  const children = Array.from({ length: 5 }, () => Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ORCA_HOME: home }, stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0, 0, 0, 0]);
  writeFileSync(join(paths.project(project), "tasks.json.abandoned.tmp"), "half a write");
  expect(await allTasks(project)).toHaveLength(1); expect((await getTask(project, id)).revision).toBe(1);
});

test("restart recovery preserves unknown tasks, respects live pids and launch grace, duplicate sweeps do not duplicate events", async () => {
  const t = await registerTask(project, input()); await prepare(t, "run");
  await recoverTaskRuns(project, new Set(), () => false); expect((await getTask(project, t.id)).runs[0]?.state).toBe("prepared");
  await beginRun(info("run"), 444);
  await recoverTaskRuns(project, new Set(), () => true); expect((await getTask(project, t.id)).attention).toBeUndefined();
  await recoverTaskRuns(project, new Set(), () => false); const recovered = await getTask(project, t.id);
  expect(recovered.attention?.kind).toBe("unknown"); expect(recovered.archive).toBeUndefined();
  await recoverTaskRuns(project, new Set(), () => false); expect(await getTask(project, t.id)).toEqual(recovered);
  await prepare(t, "missing"); await recoverTaskRuns(project, new Set(), () => false, Date.now() + 31_000);
  expect((await getTask(project, t.id)).attention?.kind).toBe("unknown");
});

test("queued updates cannot resurrect a deleted/recreated project", async () => {
  const t = await registerTask(project, input()); let release!: () => void, entered!: () => void;
  const inLock = new Promise<void>(r => { entered = r; }); const blocked = new Promise<void>(r => { release = r; });
  const deletion = withProjectStateLock(project, async () => { entered(); await blocked; rmSync(paths.project(project), { recursive: true }); mkdirSync(paths.project(project)); });
  await inLock;
  const change = setTaskAttention(project, t.id, { kind: "blocked", reason: "Old project" }).catch(e => e);
  release(); await deletion; expect(await change).toBeInstanceOf(Error); expect(await listTasks(project)).toEqual([]);
});

test("registry updates never consume questions or durable agent/user message queues", async () => {
  await ask(project, [{ text: "Unresolved question" }]);
  await put(project, "user", { from: "orchestrator", text: "Report" }); await put(project, "orchestrator", { from: "worker-x", text: "Message" });
  const t = await registerTask(project, input()); await setTaskAttention(project, t.id, { kind: "blocked", reason: "Waiting" });
  await listTasks(project);
  expect(await questions(project)).toHaveLength(1); expect(await pending(project, "user")).toBe(true); expect(await pending(project, "orchestrator")).toBe(true);
});

test("explicit blocked/cancelled attention survives a subsequent normal agent report/exit", async () => {
  for (const kind of ["blocked", "cancelled"] as const) {
    const t = await registerTask(project, input(`feat/${kind}`));
    await prepareTaskRun(project, t.id, t.branch, { id: kind, agent: `worker-${kind}`, role: "worker" });
    await startTaskRun(project, kind); await setTaskAttention(project, t.id, { kind, reason: "Needs user continuation" });
    await stopTaskRun(project, kind, "waiting", "Reported");
    expect((await getTask(project, t.id)).attention).toEqual({ kind, reason: "Needs user continuation" });
    expect((await getTask(project, t.id)).readiness).toBeUndefined();
  }
});

test("readiness evidence remains in history after invalidation; live cancellation cannot leave a ready row", async () => {
  const t = await ready(); publishLaunch(project, "reviewer-feat-x", "reviewer");
  await cancelSession(project, "reviewer-feat-x");
  const cancelled = await getTask(project, t.id);
  expect(cancelled.status).toBe("reviewing"); expect(cancelled.readiness).toBeUndefined();
  expect(cancelled.attention?.kind).toBe("cancelled");
  expect(cancelled.history.find(e => e.kind === "readiness_validated")?.readiness).toEqual(t.readiness);
});

test("one cancelled reviewer invalidates readiness for every explicitly included task it validated", async () => {
  const first = await registerTask(project, input());
  const second = await registerTask(project, { ...input(), summary: "Separate follow-up" });
  await prepare(first, "first"); await startTaskRun(project, "first"); await stopTaskRun(project, "first", "waiting", "Reported");
  await prepare(second, "reviewer", "reviewer"); await startTaskRun(project, "reviewer");
  for (const t of [first, second]) {
    const associated = await observeTaskPR(project, t.id, observation());
    await validateTaskReadiness(project, t.id, { run: "reviewer", revision: associated.revision, observation: observation(), validated: true, validation: "Both tasks reviewed on this head" });
  }
  await stopTaskRun(project, "reviewer", "cancelled", "cancelled by user");
  for (const t of await allTasks(project)) {
    expect(t.status).toBe("reviewing"); expect(t.readiness).toBeUndefined(); expect(t.attention?.kind).toBe("cancelled");
  }
});

test("repeating the same explicit readiness evidence is idempotent", async () => {
  const t = await ready();
  expect(await validateTaskReadiness(project, t.id, { run: "reviewer", revision: t.revision, observation: observation(), validated: true, validation: t.readiness!.validation })).toEqual(t);
});

test("cancellation racing a normal ready report wins without changing a later run", async () => {
  const t = await ready();
  await stopTaskRun(project, "reviewer", "waiting", "Reported");
  await stopTaskRun(project, "reviewer", "cancelled", "cancelled by user");
  const cancelled = await getTask(project, t.id);
  expect(cancelled.readiness).toBeUndefined(); expect(cancelled.attention?.kind).toBe("cancelled");
  await stopTaskRun(project, "reviewer", "cancelled", "cancelled by user");
  expect(await getTask(project, t.id)).toEqual(cancelled);
  await prepare(t, "authorized-new-run");
  await stopTaskRun(project, "reviewer", "cancelled", "Late cancellation");
  expect((await getTask(project, t.id)).attention?.kind).toBe("waiting");
});

test("malformed persisted run states and readiness history fail closed", async () => {
  const t = await ready(), path = join(paths.project(project), "tasks.json");
  for (const corrupt of [
    { ...t, runs: t.runs.map(r => ({ ...r, state: "prepared" })) },
    { ...t, history: t.history.map(e => e.readiness ? { ...e, readiness: {} } : e) },
    { ...t, history: t.history.map(e => e.readiness ? { ...e, readiness: undefined } : e) },
  ]) {
    writeFileSync(path, JSON.stringify({ version: 1, tasks: [corrupt] }));
    await expect(allTasks(project)).rejects.toThrow();
  }
});

test("persisted explicit review intent projects review rounds independently of CI", async () => {
  const t = await registerTask(project, { ...input(), branch: "feat/review-telemetry" });
  for (const [index, reviewMode] of (["review", "watch-ci"] as const).entries()) {
    const id = `telemetry-${index}`;
    await prepareTaskRun(project, t.id, t.branch, { id, agent: "reviewer-feat-review-telemetry", role: "reviewer", reviewMode });
    await startTaskRun(project, id);
    await stopTaskRun(project, id, "waiting", "finished");
  }
  expect((await listTasks(project)).find(row => row.id === t.id)?.review).toEqual({ rounds: 1, unknown: false, ci: true });
});
