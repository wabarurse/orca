import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createAgent } from "./agent";
import { put } from "../../data/inbox/inbox";
import type { Provider } from "../../../providers/provider";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import type { Transcript } from "../../data/transcripts/transcript";
import type { Entry, NewEntry } from "../../../protocol/transcript";
import type { Tool, ToolContext } from "../../tools/registry";

const home = mkdtempSync(join(tmpdir(), "orca-agent-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const user = (text: string): NewEntry => ({ type: "message", message: { role: "user", content: text } });

function fakeTranscript(): Transcript & { entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    path: "/dev/null",
    entries,
    async append(e) {
      const entry = { ...e, uuid: String(entries.length), ts: "t" } as Entry;
      entries.push(entry);
      return entry;
    },
    async chain() {
      return entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
    },
    head() {
      return entries.at(-1)?.uuid ?? null;
    },
    branch: () => entries,
  };
}

const ctx: ToolContext = { project: "p", role: "worker", cwd: "/" };

const echo: Tool = {
  spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } },
  async run(input) {
    return `echo:${input.text}`;
  },
};

const boom: Tool = {
  spec: { name: "boom", description: "fails", input_schema: { type: "object", properties: {} } },
  async run() {
    throw new Error("kaboom");
  },
};

describe("agent loop", () => {
  test("text-only turn ends the loop and is streamed", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("hi"));
    const provider = fakeProvider([[text("hello")]]);
    const { calls } = provider;
    let out = "";
    await createAgent({ provider, transcript, tools: {}, model: "m", ctx, write: (t, plain) => { if (!plain) out += t; } }).run();

    expect(calls.length).toBe(1);
    expect(calls[0]!.tools).toEqual([]);
    expect(out).toBe("hello\n");
    expect(transcript.entries.length).toBe(2);
    expect(transcript.entries[1]!.type).toBe("message");
    expect((transcript.entries[1] as { message: MessageParam }).message.role).toBe("assistant");
  });

  test("tool call round-trips its result", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const provider = fakeProvider([[toolUse("tu1", "echo", { text: "x" })], [text("done")]]);
    const { calls } = provider;
    await createAgent({ provider, transcript, tools: { echo }, model: "m", ctx, write: () => {} }).run();

    expect(calls.length).toBe(2);
    expect(calls[0]!.tools).toEqual(["echo"]);
    const second = calls[1]!.messages;
    expect(second.length).toBe(3);
    expect(second[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "echo:x" }]);
    expect(transcript.entries.length).toBe(4);
  });

  test("tool error becomes is_error, not a crash", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const provider = fakeProvider([[toolUse("tu1", "boom", {})], [text("ok")]]);
    const { calls } = provider;
    await createAgent({ provider, transcript, tools: { boom }, model: "m", ctx, write: () => {} }).run();

    const results = calls[1]!.messages[2]!.content;
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "kaboom", is_error: true }]);
  });

  test("messages waiting in the inbox are read before the first request and after each turn", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    await put("p", "worker", { from: "orchestrator", text: "note before start" });
    let turns = 0;
    const inner = fakeProvider([[text("first")], [text("second")]]);
    const { calls } = inner;
    const provider: Provider = {
      ...inner,
      async complete(req) {
        // A message lands while the agent is working on its first turn.
        if (turns++ === 0) await put("p", "worker", { from: "orchestrator", text: "one more thing" });
        return inner.complete(req);
      },
    };
    await createAgent({ provider, transcript, tools: {}, model: "m", ctx, write: () => {} }).run();

    expect(calls.length).toBe(2);
    expect(calls[0]!.messages.at(-1)!.content).toBe("[orchestrator] note before start");
    expect(calls[1]!.messages.at(-1)!.content).toBe("[orchestrator] one more thing");
  });

  test("a message that lands during a tool call waits for the result, then rides along with it", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const order: string[] = [];
    const slow: Tool = {
      spec: { name: "slow", description: "slow", input_schema: { type: "object", properties: {} } },
      async run() {
        // The note arrives mid-tool; it must not be seen until the tool is done.
        await put("p", "worker", { from: "orchestrator", text: "change of plan" });
        order.push("tool finished");
        return "done";
      },
    };
    const provider = fakeProvider([[toolUse("t1", "slow", {})], [text("ok")]]);
    await createAgent({ provider, transcript, tools: { slow }, model: "m", ctx, write: () => {} }).run();

    expect(provider.calls.length).toBe(2);
    const last = provider.calls[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "done" },
      { type: "text", text: "[orchestrator] change of plan" },
    ]);
    expect(order).toEqual(["tool finished"]);
  });
});

test("cancelled tool batch pairs every call, skips later tools, and is resumable", async () => {
  const controller = new AbortController();
  const transcript = fakeTranscript();
  await transcript.append(user("original task"));
  let executions = 0;
  const cancel: Tool = { ...echo, async run(_input, ctx) {
    executions++;
    expect(ctx.signal).toBe(controller.signal);
    controller.abort(new Error("cancelled by user"));
    ctx.signal!.throwIfAborted();
    return "unreachable";
  } };
  const provider = fakeProvider([[toolUse("a", "cancel", {}), toolUse("b", "echo", {})]]);
  await expect(createAgent({ provider, transcript, tools: { cancel, echo }, model: "m", ctx, signal: controller.signal, write() {} }).run()).rejects.toThrow("cancelled by user");
  expect(executions).toBe(1);
  expect(provider.calls).toHaveLength(1);
  const messages = await transcript.chain();
  const results = messages.at(-1)!.content;
  expect(results).toEqual([
    { type: "tool_result", tool_use_id: "a", content: "cancelled by user", is_error: true },
    { type: "tool_result", tool_use_id: "b", content: "cancelled by user", is_error: true },
  ]);
  const { paired } = await import("../../data/memory/tool-pairs");
  expect(paired(messages)).toBe(true);
  await transcript.append(user("continue"));
  const next = fakeProvider([[text("resumed")]]);
  await createAgent({ provider: next, transcript, tools: {}, model: "m", ctx, write() {} }).run();
  expect(next.calls[0]!.messages).toEqual([...messages, { role: "user", content: "continue" }]);
});

test("cancelled provider request retains input but never appends incomplete tool calls", async () => {
  const controller = new AbortController();
  const transcript = fakeTranscript();
  await transcript.append(user("keep this"));
  const provider: Provider = { name: "anthropic", async models() { return []; }, async complete(req) {
    expect(req.signal).toBe(controller.signal);
    req.onText("partial answer");
    controller.abort(new Error("cancelled"));
    // Even a provider that races a completed result with cancellation cannot run tools.
    return { stop: "tool_use", content: [toolUse("partial", "echo", {})] };
  } };
  await expect(createAgent({ provider, transcript, tools: { echo }, model: "m", ctx, signal: controller.signal, write() {} }).run()).rejects.toThrow("cancelled");
  expect(await transcript.chain()).toEqual([{ role: "user", content: "keep this" }]);
});


/** Shared wiring only; each test supplies its failure at the relevant boundary. */
async function lifecycleScenario(name: string) {
  const { beginRun, readRun } = await import("../../tmux/exits");
  const project = `lifecycle-${name}`;
  const tracker = await beginRun({ project, id: "worker", run: "r", role: "worker", cwd: "/" });
  const transcript = fakeTranscript();
  await transcript.append(user("private prompt"));
  const controller = new AbortController();
  const secret = new Error("sensitive provider error");
  const stages: string[] = [];
  const lines: string[] = [];
  const behavior = {
    prepare: () => {},
    complete: async (): Promise<Awaited<ReturnType<Provider["complete"]>>> => ({ content: [text("private output")], stop: "end" }),
  };
  const request = tracker.request!;
  tracker.request = async (state) => {
    stages.push(state.stage);
    await request(state);
    if (state.stage === "preparing") behavior.prepare();
  };
  let calls = 0;
  const latest = async () => (await readRun(project, "worker"))!.modelRequest!;
  const provider: Provider = { ...fakeProvider([]), name: "openai", async complete(req) {
    calls++;
    expect(stages).toEqual(["preparing", "provider-wait"]);
    expect(req.model).toBe("selected-model");
    expect((await latest()).stage).toBe("provider-wait");
    return behavior.complete();
  } };
  const agent = createAgent({ provider: fakeProvider([]), model: "old-model", resolveModel: async () => ({ model: "selected-model", provider }),
    transcript, tools: {}, ctx, tracker, signal: controller.signal,
    write: (t, plain) => { if (plain) lines.push(t); } });
  return { agent, behavior, transcript, controller, secret, stages, lines, tracker, latest, calls: () => calls };
}

async function expectLifecycle(scenario: Awaited<ReturnType<typeof lifecycleScenario>>, stages: string[], calls: number) {
  expect(scenario.calls()).toBe(calls);
  expect(scenario.stages).toEqual(stages);
  const saved = await scenario.latest();
  expect(saved).toEqual({ model: "selected-model", provider: "openai", stage: stages.at(-1), startedAt: expect.any(String), updatedAt: expect.any(String) });
  expect(Number.isNaN(Date.parse(saved.startedAt))).toBe(false);
  for (const line of scenario.lines) {
    expect(line).toContain("openai/selected-model");
    expect(line).toContain(`started ${saved.startedAt}`);
  }
  const evidence = JSON.stringify(saved) + scenario.lines.join("");
  for (const sensitive of ["private prompt", "private output", scenario.secret.message]) expect(evidence).not.toContain(sensitive);
  await scenario.tracker.request!({ ...saved, stage: "preparing", startedAt: "next" });
  expect((await scenario.latest()).startedAt).toBe("next");
}

describe("model request lifecycle", () => {
  test("completion keeps safe latest evidence for the selected model", async () => {
    const scenario = await lifecycleScenario("completed");
    await scenario.agent.run();
    await expectLifecycle(scenario, ["preparing", "provider-wait", "completed"], 1);
    console.info("Captured existing plain status writer (not a TUI rendering):\n" + scenario.lines.join(""));
  });

  test("provider error preserves the thrown error without retry", async () => {
    const scenario = await lifecycleScenario("error");
    scenario.behavior.complete = async () => { throw scenario.secret; };
    await expect(scenario.agent.run()).rejects.toBe(scenario.secret);
    await expectLifecycle(scenario, ["preparing", "provider-wait", "error"], 1);
  });

  test("abort keeps safe evidence and preserves the thrown error", async () => {
    const scenario = await lifecycleScenario("aborted");
    scenario.behavior.complete = async () => { scenario.controller.abort(scenario.secret); throw scenario.secret; };
    await expect(scenario.agent.run()).rejects.toBe(scenario.secret);
    await expectLifecycle(scenario, ["preparing", "provider-wait", "aborted"], 1);
  });

  test("preparation error never invokes the provider", async () => {
    const scenario = await lifecycleScenario("preparation-error");
    // Fail only the chain inside ask, not the earlier context/budget boundaries.
    scenario.behavior.prepare = () => { scenario.transcript.chain = async () => { throw scenario.secret; }; };
    await expect(scenario.agent.run()).rejects.toBe(scenario.secret);
    await expectLifecycle(scenario, ["preparing", "error"], 0);
  });

  test("diagnostic write failures do not prevent a request", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("hi"));
    const provider = fakeProvider([[text("ok")]]);
    await createAgent({ transcript, provider, model: "m", tools: {}, ctx,
      tracker: { model: async () => {}, request: async () => { throw new Error("disk"); }, tool: async () => {}, instructed: async () => {}, reported: async () => {} },
      write: (_t, plain) => { if (plain) throw new Error("display"); },
    }).run();
    expect(provider.calls).toHaveLength(1);
  });
});
