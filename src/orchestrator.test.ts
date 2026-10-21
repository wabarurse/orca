// End to end over the real transcript, tasks, inbox and tools, with a scripted
// model and a fake runner so nothing hits the API, git or tmux.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { put } from "./inbox";
import { createOrchestrator, ensureProject } from "./orchestrator";
import type { Runner, StartOptions } from "./runner";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { message } from "./tools/message";
import { makeSpawn } from "./tools/spawn";
import { open } from "./transcript";

const home = mkdtempSync(join(tmpdir(), "parallels-e2e-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const started: StartOptions[] = [];
const runner: Runner = {
  async start(o) {
    started.push(o);
  },
  async stop() {},
};
const tools = { spawn: makeSpawn(runner), message };
const project = "demo";

test("user asks for a feature: orchestrator spawns a worker and replies", async () => {
  const provider = fakeProvider([
    [text("Splitting that into one task."), toolUse("tu1", "spawn", { prompt: "Add a login page", branch: "feat/login" })],
    [toolUse("tu2", "message", { to: "user", text: "Started a worker on feat/login." })],
    [text("done")],
  ]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  await orch.say("build me a login page");
  expect(await orch.pending()).toBe(true);

  const replies = await orch.turn();
  expect(replies.map((r) => r.text)).toEqual(["Started a worker on feat/login."]);
  expect(started).toEqual([{ project, role: "worker", branch: "feat/login" }]);
  expect(await orch.pending()).toBe(false);

  // The inbox message reached the model as one user message with the sender tagged.
  expect(provider.calls[0]!.messages.at(-1)?.content).toBe("[user] build me a login page");
});

test("worker reports back: orchestrator spawns a reviewer on the same branch", async () => {
  const provider = fakeProvider([
    [toolUse("tu3", "spawn", { prompt: "Review PR #12", branch: "feat/login", role: "reviewer" }), toolUse("tu4", "message", { to: "user", text: "feat/login is in review." })],
    [text("ok")],
  ]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  await put(project, "orchestrator", { from: "worker-feat-login", text: "Done, PR #12" });

  const replies = await orch.turn();
  expect(replies[0]?.text).toBe("feat/login is in review.");
  expect(started.at(-1)).toEqual({ project, role: "reviewer", branch: "feat/login" });
});

test("the orchestrator transcript persists across restarts", async () => {
  const t = open(paths.transcript(project, "orchestrator"));
  const chain = await t.chain();
  expect(chain[0]?.content).toBe("[user] build me a login page");
  expect(chain.some((m) => typeof m.content === "string" && m.content.includes("[worker-feat-login] Done, PR #12"))).toBe(true);
});

test("a turn with an empty inbox does nothing", async () => {
  const provider = fakeProvider([]);
  const orch = await createOrchestrator({ project, provider, tools, write: () => {} });
  expect(await orch.turn()).toEqual([]);
  expect(provider.calls).toHaveLength(0);
});

test("spawn seeded the worker and reviewer transcripts with their prompts", async () => {
  const worker = await open(paths.transcript(project, "worker-feat-login")).chain();
  expect(worker[0]?.content).toBe("Branch: feat/login\n\nAdd a login page");
  const reviewer = await open(paths.transcript(project, "reviewer-feat-login")).chain();
  expect(reviewer[0]?.content).toBe("Branch: feat/login\n\nReview PR #12");
});

test("ensureProject starts an empty repository when no url is given", async () => {
  await ensureProject("fresh");
  const head = Bun.file(paths.repo("fresh") + "/.git/HEAD");
  expect(await head.exists()).toBe(true);
  await ensureProject("fresh"); // idempotent
  expect(await head.exists()).toBe(true);
});
