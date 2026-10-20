// End to end over the real transcript, tasks, inbox and tools, with a scripted
// model and a fake runner so nothing hits the API, git or tmux.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "@anthropic-ai/sdk/resources/messages";
import type { AgentClient } from "./agent";
import { paths } from "./config";
import { put } from "./inbox";
import { createOrchestrator } from "./orchestrator";
import type { Runner, StartOptions } from "./runner";
import { message } from "./tools/message";
import { makeSpawn } from "./tools/spawn";
import { open } from "./transcript";

const home = mkdtempSync(join(tmpdir(), "parallels-e2e-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const text = (t: string): ContentBlock => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: unknown): ContentBlock =>
  ({ type: "tool_use", id, name, input }) as ContentBlock;

/** A model that answers each request with the next scripted reply. */
function scriptedClient(script: ContentBlock[][], seen: Message["content"][] = []): AgentClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    messages: {
      stream(params) {
        requests.push(params);
        const content = script.shift() ?? [text("(no more script)")];
        const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
        return {
          on() {
            return this;
          },
          async finalMessage() {
            return { content, stop_reason: stop } as Message;
          },
        };
      },
    },
  };
}

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
  const client = scriptedClient([
    [text("Splitting that into one task."), toolUse("tu1", "spawn", { prompt: "Add a login page", branch: "feat/login" })],
    [toolUse("tu2", "message", { to: "user", text: "Started a worker on feat/login." })],
    [text("done")],
  ]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
  await orch.say("build me a login page");
  expect(await orch.pending()).toBe(true);

  const replies = await orch.turn();
  expect(replies.map((r) => r.text)).toEqual(["Started a worker on feat/login."]);
  expect(started).toEqual([{ project, role: "worker", branch: "feat/login" }]);
  expect(await orch.pending()).toBe(false);

  // The inbox message reached the model as one user message with the sender tagged.
  const first = client.requests[0] as { messages: { content: unknown }[] };
  expect(first.messages.at(-1)?.content).toBe("[user] build me a login page");
});

test("worker reports back: orchestrator spawns a reviewer on the same branch", async () => {
  const client = scriptedClient([
    [toolUse("tu3", "spawn", { prompt: "Review PR #12", branch: "feat/login", role: "reviewer" }), toolUse("tu4", "message", { to: "user", text: "feat/login is in review." })],
    [text("ok")],
  ]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
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
  const client = scriptedClient([]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
  expect(await orch.turn()).toEqual([]);
  expect(client.requests).toHaveLength(0);
});

test("spawn seeded the worker and reviewer transcripts with their prompts", async () => {
  const worker = await open(paths.transcript(project, "worker-feat-login")).chain();
  expect(worker[0]?.content).toBe("Branch: feat/login\n\nAdd a login page");
  const reviewer = await open(paths.transcript(project, "reviewer-feat-login")).chain();
  expect(reviewer[0]?.content).toBe("Branch: feat/login\n\nReview PR #12");
});
