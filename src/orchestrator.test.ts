// End to end over the real transcript, tasks, inbox and tools, with a scripted
// model and a fake runner so nothing hits the API, git or tmux.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "@anthropic-ai/sdk/resources/messages";
import { taskBrief, type AgentClient } from "./agent";
import { paths } from "./config";
import { put } from "./inbox";
import { createOrchestrator, formatInbox } from "./orchestrator";
import type { Runner, StartOptions } from "./runner";
import { readTasks } from "./tasks";
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
    [text("Splitting that into one task."), toolUse("tu1", "spawn", { desc: "Add a login page" })],
    [toolUse("tu2", "message", { text: "Started t1." })],
    [text("done")],
  ]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
  await orch.say("build me a login page");
  expect(await orch.pending()).toBe(true);

  const replies = await orch.turn();
  expect(replies.map((r) => r.text)).toEqual(["Started t1."]);
  expect(started).toEqual([{ project, role: "worker", taskId: "t1", branch: "t1-add-a-login-page" }]);
  expect((await readTasks(project))[0]?.status).toBe("working");
  expect(await orch.pending()).toBe(false);

  // The inbox message reached the model as one user message with the sender tagged.
  const first = client.requests[0] as { messages: { content: unknown }[] };
  expect(first.messages.at(-1)?.content).toBe("[user] build me a login page");
});

test("worker reports back: orchestrator spawns the reviewer on the same task", async () => {
  const client = scriptedClient([
    [toolUse("tu3", "spawn", { task: "t1" }), toolUse("tu4", "message", { text: "t1 is in review." })],
    [text("ok")],
  ]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
  await put(project, { from: "worker-t1", text: "Done, PR #12" });

  const replies = await orch.turn();
  expect(replies[0]?.text).toBe("t1 is in review.");
  expect(started.at(-1)).toEqual({ project, role: "reviewer", taskId: "t1", branch: "t1-add-a-login-page" });
  expect((await readTasks(project))[0]?.status).toBe("review");
});

test("the orchestrator transcript persists across restarts", async () => {
  const t = open(paths.transcript(project, "orchestrator"));
  const chain = await t.chain();
  expect(chain[0]?.content).toBe("[user] build me a login page");
  expect(chain.some((m) => typeof m.content === "string" && m.content.includes("[worker-t1] Done, PR #12"))).toBe(true);
});

test("a turn with an empty inbox does nothing", async () => {
  const client = scriptedClient([]);
  const orch = await createOrchestrator({ project, client, tools, write: () => {} });
  expect(await orch.turn()).toEqual([]);
  expect(client.requests).toHaveLength(0);
});

test("workers and reviewers are briefed from tasks.json", async () => {
  expect(await taskBrief(project, "worker", "t1")).toBe("Implement task t1 on branch `t1-add-a-login-page`.\n\nAdd a login page");
  expect(await taskBrief(project, "reviewer", "t1")).toStartWith("Review task t1");
  expect(taskBrief(project, "worker", "t9")).rejects.toThrow("no task t9");
});

test("formatInbox tags each sender", () => {
  expect(formatInbox([{ from: "a", text: "x", ts: "" }, { from: "b", text: "y", ts: "" }])).toBe("[a] x\n\n[b] y");
});
