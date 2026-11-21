import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { ok, paths } from "../../config";
import { fakeProvider, text, toolUse } from "../../test/fake-provider";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { pending, put } from "../inbox";
import type { Runtime, Tool } from "../tools/registry";
import type { PluginContext } from "../plugins/types";
import { openTranscript } from "../transcript";
import type { AgentEvent } from "../types";
import { spanRecorder } from "../spans";
import { createAgent, type AgentSetup } from "./agent";
import { emptyHooks, type LoopHooks } from "./hooks";

const home = tempHome("loop");

const runtime: Runtime = { spawn: async () => { throw new Error("no"); }, agents: async () => [], stop: async () => "", confirm: async () => false };

function echoTool(onRun: () => Promise<void> = async () => {}): Tool {
  return { parallel: () => false, spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: { text: { type: "string" } } } },
    async run(input) { await onRun(); return `echo: ${String(input.text)}`; } };
}

async function setup(script: ContentBlock[][], tools: Tool[], hooks: LoopHooks = emptyHooks(), confirm = async () => false) {
  const conversation = await createConversation(home.path(), "t");
  const provider = fakeProvider(script);
  const events: AgentEvent[] = [];
  const transcript = openTranscript(paths.transcript(conversation.id, "orchestrator"));
  const config: AgentSetup = {
    conversation: conversation.id, agent: "orchestrator", role: "orchestrator", branch: null, cwd: home.path(), data: home.path(), trusted: false, pluginSkills: [],
    transcript, tools, system: "test", resolve: async () => ok({ model: "claude-sonnet-5-5", provider, settings: null, contextLimit: null }),
    context: async () => ({}), hooks, runtime: { ...runtime, confirm }, emit: event => { events.push(event); }, signal: new AbortController().signal,
    concurrency: 1, rolling: null, requireInput: true, compactRequested: () => false, spans: spanRecorder(conversation.id, "orchestrator", event => { events.push(event); }),
  };
  return { conversation: conversation.id, provider, events, transcript, agent: createAgent(config) };
}

describe("agent loop", () => {
  test("a message gets a reply, and nothing runs without input", async () => {
    const s = await setup([[text("hello back")]], []);
    expect((await s.agent.run()).status).toBe("done");
    expect(s.provider.calls.length).toBe(0);
    await put(s.conversation, "orchestrator", "user", "hello", { images: [], delivery: "steer" });
    const result = await s.agent.run();
    expect(result).toEqual({ status: "done", text: "hello back", error: null });
    expect(s.transcript.chain().map(m => m.role)).toEqual(["user", "assistant"]);
    expect(await pending(s.conversation, "orchestrator")).toEqual([]);
  });

  test("steer input joins the next tool batch; follow-up input waits until the work is done", async () => {
    let conversation = "";
    const s = await setup([[toolUse("t1", "echo", { text: "a" })], [text("first done")], [text("follow handled")]], [echoTool(async () => {
      await put(conversation, "orchestrator", "user", "later please", { images: [], delivery: "follow" });
      await put(conversation, "orchestrator", "user", "also this", { images: [], delivery: "steer" });
    })]);
    conversation = s.conversation;
    await put(conversation, "orchestrator", "user", "go", { images: [], delivery: "steer" });
    expect((await s.agent.run()).text).toBe("follow handled");
    const blocks = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
    expect(blocks.map(b => b.type)).toEqual(["tool_result", "text"]);
    expect(blocks[1]?.text).toBe("[user] also this");
    expect(JSON.stringify(s.provider.calls[1]?.messages)).not.toContain("later please");
    expect(JSON.stringify(s.provider.calls[2]?.messages.at(-1))).toContain("later please");
  });

  test("hooks change input, block, ask, rewrite results, shape requests and filter input", async () => {
    const hooks = emptyHooks();
    const ctx: PluginContext = { plugin: "p", conversation: "", agent: "orchestrator", role: "orchestrator", cwd: "", data: async () => ok("") };
    hooks.beforeTool.push({ ctx, hook: async call => call.input.text === "secret" ? { action: "block", reason: "no secrets" }
      : call.input.text === "ask" ? { action: "ask", question: "ok?" } : { action: "run", input: { text: `${String(call.input.text)}!` } } });
    hooks.afterTool.push({ ctx, hook: async (_call, result) => ({ ...result, content: `${String(result.content)} (checked)` }) });
    hooks.beforeRequest.push({ ctx, hook: async request => ({ ...request, system: `${request.system} +plugin` }) });
    hooks.onInput.push({ ctx, hook: async message => message.text.includes("spam") ? { action: "drop", reason: "spam" } : { action: "keep", text: message.text.toUpperCase() } });
    const s = await setup([[toolUse("a", "echo", { text: "hi" }), toolUse("b", "echo", { text: "secret" }), toolUse("c", "echo", { text: "ask" })], [text("ok")]], [echoTool()], hooks);
    await put(s.conversation, "orchestrator", "user", "spam spam", { images: [], delivery: "steer" });
    await put(s.conversation, "orchestrator", "user", "run it", { images: [], delivery: "steer" });
    await s.agent.run();
    expect(JSON.stringify(s.provider.calls[0]?.messages)).toContain("[user] RUN IT");
    expect(JSON.stringify(s.provider.calls[0]?.messages)).not.toContain("spam");
    const results = z.array(z.looseObject({ content: z.string(), is_error: z.boolean().optional() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
    expect(results[0]?.content).toBe("echo: hi! (checked)");
    expect(results[1]).toMatchObject({ is_error: true, content: "blocked by plugin p: no secrets" });
    expect(results[2]?.content).toContain("the user declined");
    expect(s.events.some(e => e.kind === "notice" && e.text.includes("dropped"))).toBe(true);
  });

  test("an unknown tool and a throwing tool become error results, never a crash", async () => {
    const broken: Tool = { parallel: () => false, spec: { name: "boom", description: "", input_schema: { type: "object", properties: {} } }, async run() { throw new Error("kaput"); } };
    const s = await setup([[toolUse("a", "nope", {}), toolUse("b", "boom", {})], [text("recovered")]], [broken]);
    await put(s.conversation, "orchestrator", "user", "go", { images: [], delivery: "steer" });
    expect((await s.agent.run()).text).toBe("recovered");
    const results = z.array(z.looseObject({ content: z.string() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
    expect(results.map(r => r.content)).toEqual(["unknown tool: nope", "kaput"]);
  });

  test("a guarded command reaches the model as a refused tool result, nothing runs, and the span records it", async () => {
    const ran: string[] = [];
    const shell: Tool = { parallel: () => false, spec: { name: "bash", description: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      async run(input) { ran.push(String(input.command)); return "ran"; } };
    const s = await setup([[toolUse("g", "bash", { command: "grep -ril 'agent notes' ." })], [toolUse("h", "bash", { command: "rg -n -i -l 'agent notes'" })], [text("found")]], [shell]);
    await put(s.conversation, "orchestrator", "user", "find agent notes", { images: [], delivery: "steer" });
    expect((await s.agent.run()).text).toBe("found");
    const results = z.array(z.looseObject({ content: z.string(), is_error: z.boolean().optional() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
    expect(results[0]).toMatchObject({ is_error: true, content: "refused (recursive-grep): recursive grep walks node_modules, build output and .git, and can take minutes. Use: rg -n -i -l 'agent notes' (or git grep -n -i -l 'agent notes')" });
    expect(ran).toEqual(["rg -n -i -l 'agent notes'"]);
    const spans = s.events.flatMap(e => e.kind === "span_end" && e.span.kind === "tool" ? [e.span.detail] : []);
    expect(spans[0]).toMatchObject({ tool: "bash", ok: "no", refused: "recursive-grep" });
    expect(spans[1]?.refused).toBeUndefined();
  });
});
