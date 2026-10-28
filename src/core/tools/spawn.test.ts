import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config/config";
import { consume, content, drain, pending, put } from "../data/inbox/inbox";
import type { Runner, StartOptions } from "../tmux/runner";
import { open } from "../data/transcripts/transcript";
import type { ToolContext } from "./registry";
import { message } from "./message";
import { makeSpawn as realSpawn } from "./spawn";
import { getTask, registerTask, stopTaskRun, taskForRun } from "../data/tasks/tasks";
// Legacy spawn behavior tests use explicit authorized records and simulated finished runs.
const taskIds = new Map<string, string>();
function makeSpawn(...args: Parameters<typeof realSpawn>) {
  const tool = realSpawn(...args);
  return { ...tool, async run(input: Record<string, unknown>, ctx: ToolContext) {
    if (typeof input.branch !== "string" || !input.prompt || ctx.role !== "orchestrator") return tool.run(input, ctx);
    mkdirSync(paths.project(ctx.project), { recursive: true });
    const key = `${ctx.project}/${input.branch}`;
    let id = taskIds.get(key);
    if (!id) { id = (await registerTask(ctx.project, { name: "Test task", summary: "Authorized test work", branch: input.branch, authorized: true })).id; taskIds.set(key, id); }
    const result = await tool.run({ ...input, taskId: id }, ctx);
    const { launchIdentity } = await import("../tmux/cancellation");
    const run = launchIdentity(ctx.project, result);
    if (run && await taskForRun(ctx.project, run)) await stopTaskRun(ctx.project, run, "waiting", "Fake process ended");
    return result;
  } };
}

const home = mkdtempSync(join(tmpdir(), "orca-spawn-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const started: StartOptions[] = [];
const fakeRunner: Runner = {
  async start(opts) {
    started.push(opts);
  },
  async stop() {},
  async running() { return []; },
};
const spawn = makeSpawn(fakeRunner);
const ctx = (role: ToolContext["role"], branch?: string): ToolContext => ({ project: "p", role, branch, cwd: "/" });

test("spawn seeds the worker transcript with the prompt and starts it on the branch", async () => {
  const id = await spawn.run({ prompt: "Add a login page", branch: "feat/login" }, ctx("orchestrator"));
  expect(id).toBe("worker-feat-login");
  expect(started).toEqual([{ project: "p", role: "worker", branch: "feat/login", run: expect.any(String) }]);
  const chain = await open(paths.transcript("p", "worker-feat-login")).chain();
  expect(chain).toEqual([{ role: "user", content: "Branch: feat/login\n\nAdd a login page" }]);
});

test("spawn with role reviewer uses the same branch and its own transcript", async () => {
  const id = await spawn.run({ prompt: "Review it", branch: "feat/login", role: "reviewer", reviewMode: "review" }, ctx("orchestrator"));
  expect(id).toBe("reviewer-feat-login");
  expect(started.at(-1)).toEqual({ project: "p", role: "reviewer", branch: "feat/login", run: expect.any(String) });
});

test("spawning again on the same branch appends to the existing transcript", async () => {
  await spawn.run({ prompt: "Round two", branch: "feat/login", role: "reviewer", reviewMode: "review" }, ctx("orchestrator"));
  const chain = await open(paths.transcript("p", "reviewer-feat-login")).chain();
  expect(chain.map((m) => m.content)).toEqual(["Branch: feat/login\n\nReview it", "Branch: feat/login\n\nRound two"]);
});

test("spawn refuses missing input and non-orchestrators", async () => {
  expect(await spawn.run({ prompt: "" }, ctx("orchestrator"))).toContain("required");
  expect(await spawn.run({ prompt: "x", branch: "b" }, ctx("worker", "b"))).toContain("only the orchestrator");
  expect(started).toHaveLength(3);
});

test("a launch that fails becomes a tool error naming the agent, the cause and the blocked task; nothing is left as started", async () => {
  const failing: Runner = {
    async start() { throw new Error("worker-feat-dead exited (code 3) before the agent started; last output:\nboom"); },
    async stop() {}, async running() { return []; },
  };
  const error = await makeSpawn(failing).run({ prompt: "Try", branch: "feat/dead" }, ctx("orchestrator")).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("spawn: worker-feat-dead did not start: worker-feat-dead exited (code 3) before the agent started; last output:\nboom\nNothing is running on feat/dead; its task run is failed (launch failed), attention blocked: agent launch failed; no successful start confirmed. Fix the cause, then spawn again with the same taskId and branch.");
  const { launchIdentity } = await import("../tmux/cancellation");
  const task = await taskForRun("p", launchIdentity("p", "worker-feat-dead")!);
  expect(task?.attention).toEqual({ kind: "blocked", reason: "agent launch failed; no successful start confirmed" });
  expect(task?.runs.at(-1)?.state).toBe("failed");
});

describe("one agent per branch", () => {
  const wait = { waitMs: 300, pollMs: 20 };
  /** A runner whose `running` answers from `answers` in turn (the last one repeats), counting its starts. */
  const runner = (answers: (string[] | null)[]) => {
    const asked: string[][] = [];
    const starts: StartOptions[] = [];
    let i = 0;
    const r: Runner = {
      async start(o) { starts.push(o); },
      async stop() {},
      async running(_p, ids) { asked.push(ids); return answers[Math.min(i++, answers.length - 1)] ?? null; },
    };
    return { r, asked, starts };
  };
  const chain = (id: string) => open(paths.transcript("q", id)).chain();
  const qctx: ToolContext = { project: "q", role: "orchestrator", cwd: "/" };

  test("a live agent of the other role refuses after waiting, leaving the transcript unchanged", async () => {
    const { r, asked, starts } = runner([["reviewer-busy"]]);
    const t0 = Date.now();
    const out = await makeSpawn(r, wait).run({ prompt: "follow-up", branch: "busy" }, qctx);
    expect(out).toBe("refused: reviewer-busy is still running on busy and one agent works on a branch at a time, so this worker prompt was not delivered; message reviewer-busy instead, or spawn the worker again after reviewer-busy reports and exits");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // it waited first
    expect(asked[0]).toEqual(["worker-busy", "reviewer-busy"]);
    expect(asked.length).toBeGreaterThan(2);
    expect(starts).toEqual([]);
    expect(await chain("worker-busy")).toEqual([]);
  });

  test("a live agent that finishes while spawn waits: spawn goes ahead", async () => {
    const { r, starts } = runner([["reviewer-soon"], ["reviewer-soon"], []]);
    expect(await makeSpawn(r, wait).run({ prompt: "next task", branch: "soon" }, qctx)).toBe("worker-soon");
    expect(starts).toEqual([{ project: "q", role: "worker", branch: "soon", run: expect.any(String) }]);
    expect((await chain("worker-soon")).map((m) => m.content)).toEqual(["Branch: soon\n\nnext task"]);
  });

  test("a live agent of the same role (reported, supervising a dev server) receives the prompt instead of a refusal", async () => {
    const { r, asked, starts } = runner([[]]);
    const tool = makeSpawn(r, wait);
    expect(await tool.run({ prompt: "build variants", branch: "live" }, qctx)).toBe("worker-live");
    r.running = async (_p, ids) => { asked.push(ids); return ["worker-live"]; };
    const out = await tool.run({ prompt: "the user picked variant B", branch: "live" }, qctx);
    expect(out).toStartWith("delivered to running worker-live; it continues on live in its current run (task #");
    expect(asked).toEqual([["worker-live", "reviewer-live"], ["worker-live", "reviewer-live"], ["worker-live"]]); // no wait: one check, then the post-delivery check
    expect(starts).toHaveLength(1);
    expect((await drain("q", "worker-live")).map((m) => [m.from, m.text])).toEqual([["orchestrator", "the user picked variant B"]]);
    expect((await chain("worker-live")).map((m) => m.content)).toEqual(["Branch: live\n\nbuild variants"]);
  });

  test("delivery to a live agent is refused, actionably, for fresh, another task or another review mode", async () => {
    const { r, starts } = runner([[]]);
    const first = await getTask("q", (await registerTask("q", { name: "Live task", summary: "Authorized", branch: "guarded", authorized: true })).id);
    const other = await getTask("q", (await registerTask("q", { name: "Other task", summary: "Authorized", branch: "guarded", authorized: true })).id);
    const tool = realSpawn(r, wait);
    expect(await tool.run({ prompt: "start", branch: "guarded", role: "reviewer", reviewMode: "review", taskId: first.id }, qctx)).toBe("reviewer-guarded");
    r.running = async () => ["reviewer-guarded"];
    const fresh = await tool.run({ prompt: "again", branch: "guarded", role: "reviewer", reviewMode: "review", taskId: first.id, fresh: true }, qctx);
    expect(fresh).toStartWith("refused: fresh=true needs an idle reviewer, but reviewer-guarded is still running on guarded; spawn again without fresh");
    const wrongTask = await tool.run({ prompt: "again", branch: "guarded", role: "reviewer", reviewMode: "review", taskId: other.id }, qctx);
    expect(wrongTask).toStartWith(`refused: reviewer-guarded is running on guarded for task #${first.number} (${first.id}), not task #${other.number} (${other.id}); a running agent keeps its task. Spawn again with taskId ${first.id}`);
    const wrongMode = await tool.run({ prompt: "again", branch: "guarded", role: "reviewer", reviewMode: "watch-ci", taskId: first.id }, qctx);
    expect(wrongMode).toStartWith("refused: reviewer-guarded is running in review mode on guarded, not watch-ci; spawn again with reviewMode review");
    expect(await pending("q", "reviewer-guarded")).toBe(false);
    expect(await tool.run({ prompt: "round two", branch: "guarded", role: "reviewer", reviewMode: "review", taskId: first.id }, qctx)).toStartWith("delivered to running reviewer-guarded");
    expect(starts).toHaveLength(1);
  });

  test("an agent that exits right after delivery is started again on the queued prompt alone", async () => {
    const { r, starts } = runner([["worker-gone"], []]);
    const out = await realSpawn(r, wait).run({ prompt: "late follow-up", branch: "gone" }, qctx);
    expect(out).toBe("worker-gone: it exited before reading the prompt, so it was started again on gone with the prompt queued");
    expect(starts).toEqual([{ project: "q", role: "worker", branch: "gone", run: expect.any(String) }]);
    expect((await chain("worker-gone")).map((m) => m.content)).toEqual(["[orchestrator] late follow-up"]);
    expect(await pending("q", "worker-gone")).toBe(false);
  });

  test("tmux could not be asked: spawn preserves branch ownership", async () => {
    const { r, asked, starts } = runner([null]);
    expect(await makeSpawn(r, wait).run({ prompt: "x", branch: "unknown" }, qctx)).toContain("cannot verify");
    expect(asked).toHaveLength(1);
    expect(starts).toHaveLength(0);
  });

  test("a liveness exception also refuses a replacement", async () => {
    const { r, starts } = runner([]);
    r.running = async () => { throw new Error("tmux unavailable"); };
    expect(await makeSpawn(r, wait).run({ prompt: "x", branch: "unknown-error" }, qctx)).toContain("cannot verify");
    expect(starts).toHaveLength(0);
  });
});

test("message delivers to the named inbox and refuses self or empty", async () => {
  expect(await message.run({ to: "orchestrator", text: "done, PR #4" }, ctx("worker", "feat/login"))).toBe("sent to orchestrator");
  expect(await message.run({ to: "user", text: "all green" }, ctx("orchestrator"))).toBe("sent to user");
  expect(await message.run({ to: "worker-feat-login", text: "also fix the test" }, ctx("orchestrator"))).toBe("sent to worker-feat-login");
  expect(await message.run({ to: "worker-b", text: "  " }, ctx("worker", "b"))).toContain("empty");
  expect(await message.run({ text: "x" }, ctx("worker", "b"))).toContain("`to` is required");
  expect(await message.run({ to: "worker-b", text: "hi me" }, ctx("worker", "b"))).toContain("own inbox");
  expect((await drain("p", "orchestrator")).map((m) => [m.from, m.text])).toEqual([["worker-feat-login", "done, PR #4"]]);
  expect((await drain("p", "user")).map((m) => m.from)).toEqual(["orchestrator"]);
  expect((await drain("p", "worker-feat-login")).map((m) => m.text)).toEqual(["also fix the test"]);
});

test("cancelling spawn during its live-agent wait never starts a replacement", async () => {
  const controller = new AbortController();
  let checked!: () => void;
  const ready = new Promise<void>(resolve => { checked = resolve; });
  let starts = 0;
  const tool = makeSpawn({ async start() { starts++; }, async stop() {}, async running() { checked(); return ["reviewer-busy"]; } });
  const running = tool.run({ prompt: "work", branch: "busy" }, { project: "cancel-spawn", role: "orchestrator", cwd: home, signal: controller.signal });
  await ready;
  controller.abort(new Error("cancelled"));
  await expect(running).rejects.toThrow("cancelled");
  expect(starts).toBe(0);
});

for (const previous of [false, true]) test(`cancel before supervisor publication targets exact ${previous ? "respawn with old state" : "initial launch"}, not replacement`, async () => {
  const { cancelSession, launchIdentity, publishLaunch, watchCancellation } = await import("../tmux/cancellation");
  const { disk } = await import("../data/transcripts/transcript-storage");
  const { spyOn } = await import("bun:test");
  const project = `early-${previous}`, id = "worker-early";
  if (previous) {
    publishLaunch(project, id, "old");
    await Bun.write(`${paths.runs(project)}/${id}.json`, JSON.stringify({ run: "old" }));
  }
  const controller = new AbortController();
  let identity: string | undefined;
  let off = () => {};
  const diskOpen = disk.open;
  // Pause at the first staging write, before the transcript becomes visible.
  const hook = spyOn(disk, "open").mockImplementation(async (path, flags) => {
    if (path.includes(id) && flags === "wx") {
      identity = launchIdentity(project, id);
      expect(identity).toBeTruthy();
      expect(identity).not.toBe("old");
      await cancelSession(project, id);
    }
    return diskOpen(path, flags);
  });
  try {
    const tool = makeSpawn({ async running() { return []; }, async stop() {}, async start(opts) {
      expect(opts.run).toBe(identity);
      off = watchCancellation(project, id, controller, opts.run!);
    } });
    await tool.run({ prompt: "start", branch: "early" }, { project, role: "orchestrator", cwd: home });
    expect(controller.signal.aborted).toBe(true);
    publishLaunch(project, id, "replacement");
    const replacement = new AbortController();
    const stop = watchCancellation(project, id, replacement, "replacement");
    try { await Bun.sleep(110); expect(replacement.signal.aborted).toBe(false); }
    finally { stop(); }
  } finally { off(); hook.mockRestore(); }
});

test("production reviewer protocol refuses omitted intent and persists both modes through dispatch", async () => {
  const { listTasks, startTaskRun, getTask } = await import("../data/tasks/tasks");
  const task = await registerTask("p", { name: "Telemetry", summary: "Explicit reviewer intent", branch: "feat/telemetry", authorized: true });
  const runner: Runner = {
    async start(opts) {
      await startTaskRun(opts.project, opts.run!);
      await stopTaskRun(opts.project, opts.run!, "waiting", "Test reviewer finished");
    },
    async stop() {}, async running() { return []; },
  };
  const tool = realSpawn(runner);
  const base = { taskId: task.id, branch: task.branch, role: "reviewer" };
  // Even a seemingly obvious prompt must not heuristically choose a mode.
  for (const prompt of ["Review the code", "watch ci"]) {
    expect(await tool.run({ ...base, prompt }, ctx("orchestrator"))).toContain("requires reviewMode");
  }
  expect((await getTask("p", task.id)).runs).toEqual([]);
  for (const reviewMode of ["review", "watch-ci"] as const) {
    expect(await tool.run({ ...base, reviewMode, prompt: "Full task instructions" }, ctx("orchestrator"))).toBe("reviewer-feat-telemetry");
    const persisted = await getTask("p", task.id);
    expect(persisted.runs.at(-1)?.reviewMode).toBe(reviewMode);
    expect((await listTasks("p")).find(t => t.id === task.id)?.review).toEqual({ rounds: 1, unknown: false, ci: reviewMode === "watch-ci" });
  }
});

for (const role of ["worker", "reviewer"] as const) test(`${role} launch preserves old STOP / resume / new STOP across reopen and interrupted cleanup`, async () => {
  const branch = `ordering-${role}`, id = `${role}-${branch}`;
  const context = ctx("orchestrator");
  const t = open(paths.transcript("p", id));
  await t.append({ type: "message", message: { role: "user", content: "original authorized task" } });
  await put("p", id, { from: "orchestrator", text: "STOP old" });
  const directory = join(paths.inbox("p"), id);
  const name = readdirSync(directory).find(n => n.endsWith(".json"))!;
  const bytes = readFileSync(join(directory, name));
  const runner: Runner = { ...fakeRunner, async start() {
    // A send after launch publication must remain a newer instruction.
    await put("p", id, { from: "orchestrator", text: "STOP new" });
  } };
  await makeSpawn(runner).run({ branch, role, prompt: "explicit resume", ...(role === "reviewer" ? { reviewMode: "review" } : {}) }, context);
  // Simulate a crash after transcript commit but before inbox unlink.
  writeFileSync(join(directory, name), bytes);
  const reopened = open(paths.transcript("p", id));
  const delivered = await consume("p", id, reopened, async inbox => {
    await reopened.append({ type: "message", inbox, message: { role: "user", content: content(inbox) } });
  });
  expect(delivered.map(m => m.text)).toEqual(["STOP new"]);
  const saved = open(reopened.path);
  const serialized = JSON.stringify(await saved.chain());
  expect(serialized.indexOf("STOP old")).toBeLessThan(serialized.indexOf("explicit resume"));
  expect(serialized.indexOf("explicit resume")).toBeLessThan(serialized.indexOf("STOP new"));
  expect(serialized.match(/STOP old/g)).toHaveLength(1);
  expect(saved.consumed!().deliveries.size).toBe(2);
  expect(saved.history!()[0]!.type).toBe("message");
  expect(await pending("p", id)).toBe(false);
});

test("launch fails closed on unreadable queued input without starting or appending resume", async () => {
  const branch = "ordering-invalid", id = `worker-${branch}`;
  await put("p", id, { from: "orchestrator", text: "STOP" });
  const directory = join(paths.inbox("p"), id);
  writeFileSync(join(directory, readdirSync(directory).find(n => n.endsWith(".json"))!), "broken");
  let starts = 0;
  const runner: Runner = { ...fakeRunner, async start() { starts++; } };
  await expect(makeSpawn(runner).run({ branch, prompt: "resume" }, ctx("orchestrator"))).rejects.toThrow();
  expect(starts).toBe(0);
  expect(await open(paths.transcript("p", id)).chain()).toEqual([]);
  expect(await pending("p", id)).toBe(true);
});

test("empty launch transaction serializes a racing STOP; failed commit leaves old input retryable", async () => {
  const id = "worker-ordering-race", t = open(paths.transcript("p", id));
  let send!: Promise<unknown>;
  await consume("p", id, t, async inbox => {
    expect(inbox).toEqual([]);
    send = put("p", id, { from: "orchestrator", text: "STOP racing" });
    await t.append({ type: "message", inbox, message: { role: "user", content: "resume" } });
  }, true);
  await send;
  await expect(consume("p", id, t, async () => { throw new Error("publication failed"); })).rejects.toThrow("publication failed");
  expect(await pending("p", id)).toBe(true);
  expect(open(t.path).consumed!().deliveries.size).toBe(0);
  const reopened = open(t.path);
  await consume("p", id, reopened, async inbox => {
    await reopened.append({ type: "message", inbox, message: { role: "user", content: content(inbox) } });
  });
  expect((await open(t.path).chain()).map(m => m.content)).toEqual(["resume", "[orchestrator] STOP racing"]);
});
