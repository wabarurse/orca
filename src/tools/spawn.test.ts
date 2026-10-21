import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config";
import { drain } from "../inbox";
import type { Runner, StartOptions } from "../runner";
import { open } from "../transcript";
import type { ToolContext } from "./index";
import { message } from "./message";
import { makeSpawn } from "./spawn";

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
  expect(started).toEqual([{ project: "p", role: "worker", branch: "feat/login" }]);
  const chain = await open(paths.transcript("p", "worker-feat-login")).chain();
  expect(chain).toEqual([{ role: "user", content: "Branch: feat/login\n\nAdd a login page" }]);
});

test("spawn with role reviewer uses the same branch and its own transcript", async () => {
  const id = await spawn.run({ prompt: "Review it", branch: "feat/login", role: "reviewer" }, ctx("orchestrator"));
  expect(id).toBe("reviewer-feat-login");
  expect(started.at(-1)).toEqual({ project: "p", role: "reviewer", branch: "feat/login" });
});

test("spawning again on the same branch appends to the existing transcript", async () => {
  await spawn.run({ prompt: "Round two", branch: "feat/login", role: "reviewer" }, ctx("orchestrator"));
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
    expect(starts).toEqual([{ project: "q", role: "worker", branch: "soon" }]);
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
