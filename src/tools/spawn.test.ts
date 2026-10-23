import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config";
import { drain } from "../inbox";
import type { Runner, StartOptions } from "../runner";
import { open } from "../transcript";
import type { ToolContext } from "./index";
import { message } from "./message";
import { makeSpawn as realSpawn } from "./spawn";
import { registerTask, stopTaskRun, taskForRun } from "../tasks";
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
    const { launchIdentity } = await import("../cancellation");
    const run = launchIdentity(ctx.project, result);
    if (run && await taskForRun(ctx.project, run)) await stopTaskRun(ctx.project, run, "waiting", "Fake process ended");
    return result;
  } };
}

const home = mkdtempSync(join(tmpdir(), "parallels-spawn-"));
process.env.PARALLELS_HOME = home;
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
  expect(await spawn.run({ prompt: "x" }, ctx("orchestrator"))).toContain("required");
  expect(await spawn.run({ prompt: "x", branch: "b" }, ctx("worker", "b"))).toContain("only the orchestrator");
  expect(started).toHaveLength(3);
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

  test("a live agent on the branch refuses, leaving the transcript unchanged", async () => {
    const { r, asked, starts } = runner([["reviewer-busy"]]);
    const t0 = Date.now();
    const out = await makeSpawn(r, wait).run({ prompt: "follow-up", branch: "busy" }, qctx);
    expect(out).toBe("refused: reviewer-busy is still running on busy; message it, or spawn again after it reports or exits");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // it waited first
    expect(asked[0]).toEqual(["worker-busy", "reviewer-busy"]);
    expect(asked.length).toBeGreaterThan(2);
    expect(starts).toEqual([]);
    expect(await chain("worker-busy")).toEqual([]);
  });

  test("a live agent that finishes while spawn waits: spawn goes ahead", async () => {
    const { r, starts } = runner([["worker-soon"], ["worker-soon"], []]);
    expect(await makeSpawn(r, wait).run({ prompt: "next task", branch: "soon" }, qctx)).toBe("worker-soon");
    expect(starts).toEqual([{ project: "q", role: "worker", branch: "soon", run: expect.any(String) }]);
    expect((await chain("worker-soon")).map((m) => m.content)).toEqual(["Branch: soon\n\nnext task"]);
  });

  test("tmux could not be asked: spawn goes ahead as before", async () => {
    const { r, asked, starts } = runner([null]);
    expect(await makeSpawn(r, wait).run({ prompt: "x", branch: "unknown" }, qctx)).toBe("worker-unknown");
    expect(asked).toHaveLength(1);
    expect(starts).toHaveLength(1);
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
  const tool = makeSpawn({ async start() { starts++; }, async stop() {}, async running() { checked(); return ["worker-busy"]; } });
  const running = tool.run({ prompt: "work", branch: "busy" }, { project: "cancel-spawn", role: "orchestrator", cwd: home, signal: controller.signal });
  await ready;
  controller.abort(new Error("cancelled"));
  await expect(running).rejects.toThrow("cancelled");
  expect(starts).toBe(0);
});

for (const previous of [false, true]) test(`cancel before supervisor publication targets exact ${previous ? "respawn with old state" : "initial launch"}, not replacement`, async () => {
  const { cancelSession, launchIdentity, publishLaunch, watchCancellation } = await import("../cancellation");
  const { disk } = await import("../transcript-storage");
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
  const { listTasks, startTaskRun, getTask } = await import("../tasks");
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


test("editorial publication dispatch creates no code-review round; explicit tags alone determine rounds", async () => {
  const { listTasks, startTaskRun } = await import("../tasks");
  const task = await registerTask("p", { name: "Editorial", summary: "Two README sentences", branch: "docs/editorial", authorized: true });
  const tool = realSpawn({
    async start(opts) {
      await startTaskRun(opts.project, opts.run!);
      await stopTaskRun(opts.project, opts.run!, "waiting", "Test reviewer finished");
    },
    async stop() {}, async running() { return []; },
  });
  const input = { taskId: task.id, branch: task.branch, role: "reviewer", prompt: "Review two README sentences: requested wording/link validation only; no code-review round needed." };
  expect(await tool.run(input, ctx("orchestrator"))).toContain("requires reviewMode");
  expect(await tool.run({ ...input, reviewMode: "watch-ci" }, ctx("orchestrator"))).toBe("reviewer-docs-editorial");
  expect((await listTasks("p")).find(t => t.id === task.id)?.review).toEqual({ rounds: 0, unknown: false, ci: true });
  // The same editorial prose with an explicit review tag really is a review dispatch; no extension/prose classifier.
  expect(await tool.run({ ...input, reviewMode: "review" }, ctx("orchestrator"))).toBe("reviewer-docs-editorial");
  expect((await listTasks("p")).find(t => t.id === task.id)?.review).toEqual({ rounds: 1, unknown: false, ci: false });
});
