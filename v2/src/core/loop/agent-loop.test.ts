import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { Provider } from "../../api";
import { contextWindow, rememberCatalogLimits } from "../../api/model";
import { ok, paths } from "../../config";
import { fakeProvider, text, toolUse } from "../../test/fake-provider";
import { tempHome } from "../../test/home";
import { searchArchive } from "../archive";
import { createConversation } from "../conversations";
import { pending, put } from "../inbox";
import { noLinks } from "../plugins/testing";
import type { PluginContext } from "../plugins/types";
import { learnCatalog } from "../session";
import { formatReport, spanReport } from "../span-report";
import { clock, flushSpans, phaseText, phaseTracker, readSpans, spanRecorder } from "../spans";
import { bash } from "../tools/bash";
import type { GuardRule } from "../tools/bash/guard";
import type { Runtime, Tool } from "../tools/registry";
import { openTranscript } from "../transcript";
import { paired, pairResults } from "../transcript/pairs";
import type { AgentEvent, Span, SpanKind } from "../types";
import { type AgentSetup, createAgent } from "./agent";
import type { Window } from "./budget";
import { emptyHooks, type LoopHooks } from "./hooks";
import { RollingCompactor, rollingCut } from "./rolling";

describe("an agent turn", () => {
  const home = tempHome("loop");

  const runtime: Runtime = { spawn: async () => { throw new Error("no"); }, agents: async () => [], stop: async () => "", show: async () => "", confirm: async () => false };

  function echoTool(onRun: () => Promise<void> = async () => {}): Tool {
    return { parallel: () => false, spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: { text: { type: "string" } } } },
      async run(input) { await onRun(); return `echo: ${String(input.text)}`; } };
  }

  async function setup(script: ContentBlock[][], tools: Tool[], hooks: LoopHooks = emptyHooks(), confirm = async () => false, guard: GuardRule[] = []) {
    const conversation = await createConversation(home.path(), "t");
    const provider = fakeProvider(script);
    const events: AgentEvent[] = [];
    const transcript = openTranscript(paths.transcript(conversation.id, "orchestrator"));
    const config: AgentSetup = {
      conversation: conversation.id, agent: "orchestrator", role: "orchestrator", branch: null, cwd: home.path(), data: home.path(), trusted: false, pluginSkills: [], guard,
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

    test("a tool call cut off by a crash is closed before new input is written, so its result follows it directly", async () => {
      const s = await setup([[text("back")]], []);
      await s.transcript.append({ type: "message", inbox: [], message: { role: "user", content: "[user] go" } });
      await s.transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: [toolUse("t1", "echo", { text: "a" })] } });
      await put(s.conversation, "orchestrator", "user", "hi", { images: [], delivery: "steer" });
      expect((await s.agent.run()).text).toBe("back");
      const stored = s.transcript.all().flatMap(entry => entry.type === "message" ? [JSON.stringify(entry.message.content)] : []);
      const result = stored.findIndex(content => content.includes("tool_result"));
      expect(result).toBeGreaterThan(-1);
      expect(stored.findIndex(content => content.includes("[user] hi"))).toBeGreaterThan(result);
      const sent = s.provider.calls[0]?.messages ?? [];
      const use = sent.findIndex(m => JSON.stringify(m.content).includes("tool_use"));
      expect(JSON.stringify(sent[use + 1]?.content)).toContain("tool_result");
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
      const ctx: PluginContext = { plugin: "p", conversation: "", agent: "orchestrator", role: "orchestrator", branch: null, cwd: "", data: async () => ok(""), links: noLinks };
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
      const hooks = emptyHooks();
      const seen: string[] = [];
      const ctx: PluginContext = { plugin: "p", conversation: "c", agent: "orchestrator", role: "orchestrator", cwd: home.path(), branch: null, data: async () => ok(home.path()), links: noLinks };
      hooks.afterTool.push({ ctx, hook: async (call, result) => { seen.push(String(call.input.command)); return result; } });
      const s = await setup([[toolUse("g", "bash", { command: "grep -ril 'agent notes' . > ran.txt" })], [toolUse("h", "bash", { command: "echo found-it" })], [text("found")]], [bash], hooks);
      await put(s.conversation, "orchestrator", "user", "find agent notes", { images: [], delivery: "steer" });
      expect((await s.agent.run()).text).toBe("found");
      const first = z.array(z.looseObject({ content: z.string(), is_error: z.boolean().optional() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
      expect(first[0]).toMatchObject({ is_error: true, content: "refused (recursive-grep): recursive grep walks node_modules, build output and .git, and can take minutes. Use: rg -n -i -l 'agent notes' (or git grep -n -i -l 'agent notes')" });
      const second = z.array(z.looseObject({ content: z.string(), is_error: z.boolean().optional() })).parse(s.provider.calls[2]?.messages.at(-1)?.content);
      expect(second[0]).toMatchObject({ content: "found-it" });
      expect(second[0]?.is_error).toBeUndefined();
      expect(await Bun.file(`${home.path()}/ran.txt`).exists()).toBe(false);
      expect(seen).toEqual(["echo found-it"]);
      const spans = s.events.flatMap(e => e.kind === "span_end" && e.span.kind === "tool" ? [e.span.detail] : []);
      expect(spans[0]).toMatchObject({ tool: "bash", ok: "no", refused: "recursive-grep" });
      expect(spans[1]?.refused).toBeUndefined();
    });

    test("a plugin hook that rewrites a command into a guarded one is refused by bash, and plugin rules apply", async () => {
      const hooks = emptyHooks();
      const ctx: PluginContext = { plugin: "rewrite", conversation: "c", agent: "orchestrator", role: "orchestrator", cwd: home.path(), branch: null, data: async () => ok(home.path()), links: noLinks };
      hooks.beforeTool.push({ ctx, hook: async call => call.input.command === "ls" ? { action: "run", input: { command: "sudo ls" } } : { action: "run", input: call.input } });
      const noMake: GuardRule = { id: "no-make", group: "efficiency", test: call => call.command?.program === "make", reason: "this repo builds with bun", suggest: () => "bun run build" };
      const s = await setup([[toolUse("a", "bash", { command: "ls" }), toolUse("b", "bash", { command: "make all" })], [text("done")]], [bash], hooks, async () => false, [noMake]);
      await put(s.conversation, "orchestrator", "user", "list", { images: [], delivery: "steer" });
      expect((await s.agent.run()).text).toBe("done");
      const results = z.array(z.looseObject({ content: z.string(), is_error: z.boolean().optional() })).parse(s.provider.calls[1]?.messages.at(-1)?.content);
      expect(results[0]).toMatchObject({ is_error: true, content: "refused (sudo): sudo waits for a password nobody can type. Use: ask the user to run it" });
      expect(results[1]).toMatchObject({ is_error: true, content: "refused (no-make): this repo builds with bun. Use: bun run build" });
      const spans = s.events.flatMap(e => e.kind === "span_end" && e.span.kind === "tool" ? [e.span.detail] : []);
      expect(spans.map(span => span.refused)).toEqual(["sudo", "no-make"]);
    });
  });
});

describe("tool result pairing", () => {
  const use: MessageParam = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] };
  const result: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "interrupted" }] };

  test("a tool result written after newer input moves back right after its call, and the input follows it", () => {
    const broken: MessageParam[] = [{ role: "user", content: "[user] go" }, use, { role: "user", content: "[user] hi" }, result, { role: "user", content: "[user] hi again" }];
    expect(paired(broken)).toBe(false);
    const fixed = pairResults(broken);
    expect(paired(fixed)).toBe(true);
    expect(fixed).toEqual([{ role: "user", content: "[user] go" }, use, { role: "user", content: result.content }, { role: "user", content: "[user] hi" }, { role: "user", content: "[user] hi again" }]);
  });

  test("a history that is already in order, or still waiting for its results, is left exactly as it is", () => {
    const good: MessageParam[] = [{ role: "user", content: "go" }, use, { role: "user", content: [...(typeof result.content === "string" ? [] : result.content), { type: "text", text: "[user] hi" }] }];
    expect(pairResults(good)).toBe(good);
    const waiting: MessageParam[] = [{ role: "user", content: "go" }, use];
    expect(pairResults(waiting)).toEqual(waiting);
  });
});

describe("rolling compaction", () => {
  const home = tempHome("rolling");

  test("background memory publishes a summary with plugin sections and keeps the newest exchange verbatim", async () => {
    const c = await createConversation(home.path(), "r");
    const transcript = openTranscript(paths.transcript(c.id, "orchestrator"));
    await transcript.append({ type: "message", inbox: [], message: { role: "user", content: "GOAL: migrate the billing service to Postgres; decision: keep the old API" } });
    for (let i = 0; i < 30; i++) {
      await transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: `step ${i} ${"x".repeat(3000)}` } });
      await transcript.append({ type: "message", inbox: [], message: { role: "user", content: `next ${i} ${"y".repeat(3000)}` } });
    }
    await transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: "latest answer: the cutover is planned for Friday" } });
    await transcript.append({ type: "message", inbox: [], message: { role: "user", content: "LATEST: also keep the audit log" } });
    const memory = JSON.stringify({ summary: ["User goal: migrate billing to Postgres.", "Decision: keep the old API."], pending: ["Plan the cutover."] });
    const provider = fakeProvider([[text(memory)]]);
    const rolling = new RollingCompactor(c.id, transcript, { small: false, triggerTokens: 5000, tailTokens: 2000, sections: [{ title: "Pins", text: async () => "- p1: ship on friday" }] });
    const window: Window = { model: "claude-sonnet-5-5", system: "", tools: [], contextLimit: 200_000, measured: null };
    const notices: string[] = [];
    await rolling.boundary({ window, provider, signal: new AbortController().signal, notice: t => { notices.push(t); } }, true);
    const summary = transcript.branch()[0];
    expect(summary?.type).toBe("summary");
    if (summary?.type !== "summary") return;
    expect(summary.text).toContain("Pins (kept as saved; authoritative)\n- p1: ship on friday");
    expect(summary.text).toContain("Decision: keep the old API.");
    expect(JSON.stringify(summary.retained)).toContain("LATEST: also keep the audit log");
    expect(JSON.stringify(summary.retained)).not.toContain("GOAL: migrate");
    expect(notices.at(-1)).toContain("compaction complete");
    expect(searchArchive([c.id], ["billing Postgres"], 5).map(hit => hit.role)).toContain("user");
  });

  test("the cut always keeps the newest exchange, however large", () => {
    const big = "z".repeat(50_000);
    expect(rollingCut([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: big }], 10)).toBe(2);
  });
});

describe("opening a session", () => {
  const catalog = (models: () => Promise<string[]>): Provider => ({ name: "anthropic", complete: async () => { throw new Error("no model calls here"); }, models });

  test("a model missing from the built-in table gets its window from the provider's catalog before a request, not the 128k guess", async () => {
    expect(contextWindow({}, "claude-new-9").limit).toBe(128000);
    let asked = 0;
    const learned = await learnCatalog("claude-new-9", catalog(async () => { asked++; rememberCatalogLimits([["claude-new-9", 1000000]]); return ["claude-new-9"]; }), true);
    expect(learned).toBe(true);
    expect(contextWindow({}, "claude-new-9")).toEqual({ limit: 1000000, estimated: false });
    expect(await learnCatalog("claude-new-9", catalog(async () => { asked++; return []; }), true)).toBe(false);
    expect(asked).toBe(1);
  });
});

describe("activity spans", () => {
  const home = tempHome("spans");

  test("a span is emitted at start and end and appended once, never model-visible", async () => {
    const events: AgentEvent[] = [];
    const spans = spanRecorder("c-ok", "worker-a", event => { events.push(event); });
    const handle = spans.begin("tool", "bash: ls", Date.now() - 1500, "call-1");
    handle.end({ ok: "yes" });
    handle.end({ ok: "again" });
    expect(await spans.time("model", "m", async () => 7, value => ({ output: value }))).toBe(7);
    await expect(spans.time("prep", "request", async () => { throw new Error("boom"); }, () => ({}))).rejects.toThrow("boom");
    await flushSpans();
    expect(events.map(e => e.kind)).toEqual(["span_start", "span_end", "span_start", "span_end", "span_start", "span_end"]);
    const read = await readSpans("c-ok");
    expect(read.ok).toBe(true);
    const recorded = read.ok ? read.data : [];
    expect(recorded.map(s => `${s.kind}:${s.label}:${JSON.stringify(s.detail)}`)).toEqual(['tool:bash: ls:{"ok":"yes"}', 'model:m:{"output":7}', 'prep:request:{"error":"boom"}']);
    expect(recorded[0]?.id).toBe("call-1");
    expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(1500);
    expect(recorded[0]?.agent).toBe("worker-a");
  });

  test("a failed write never fails the caller and gives one notice", async () => {
    mkdirSync(paths.conversations, { recursive: true });
    writeFileSync(join(paths.conversations, "c-broken"), "not a folder");
    const notices: string[] = [];
    const spans = spanRecorder("c-broken", "orchestrator", event => { if (event.kind === "notice") notices.push(event.text); });
    spans.begin("model", "m", null, null).end({});
    spans.begin("model", "m", null, null).end({});
    await flushSpans();
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("span recording unavailable");
    expect(home.path().length).toBeGreaterThan(0);
  });

  test("a phase tracker keeps one open span per phase and closes it when the phase changes", async () => {
    const events: AgentEvent[] = [];
    const idle = phaseTracker(spanRecorder("c-phase", "orchestrator", event => { events.push(event); }));
    const first = idle.observe("wait-worker", "worker-a");
    expect(idle.observe("wait-worker", "worker-a")).toBe(first);
    idle.observe("wait-inbox", "input");
    idle.close();
    idle.close();
    await flushSpans();
    expect(events.map(e => e.kind === "span_start" || e.kind === "span_end" ? `${e.kind} ${e.span.kind}` : e.kind))
      .toEqual(["span_start wait-worker", "span_end wait-worker", "span_start wait-inbox", "span_end wait-inbox"]);
    expect(idle.current()).toBe(null);
  });

  test("phase text reads like the activity line", () => {
    const startedAt = new Date(1_000_000).toISOString();
    expect(phaseText({ id: "a", kind: "wait-worker", label: "worker-fix-x", agent: "orchestrator", startedAt }, 1_000_000 + 72_400)).toBe("waiting for worker-fix-x (1m12s)");
    expect(phaseText({ id: "b", kind: "model", label: "claude-opus-5-5", agent: "orchestrator", startedAt }, 1_000_000 + 8_900)).toBe("swimming (8s)");
    expect(clock(-5)).toBe("0s");
  });
});

describe("the time breakdown", () => {
  const T = Date.parse("2026-01-01T00:00:00.000Z");
  let n = 0;
  const span = (agent: string, kind: SpanKind, label: string, from: number, to: number): Span =>
    ({ id: `s${n++}`, kind, label, agent, startedAt: new Date(T + from * 1000).toISOString(), endedAt: new Date(T + to * 1000).toISOString(), durationMs: (to - from) * 1000, detail: {} });

  const FIXTURE: Span[] = [
    span("orchestrator", "prep", "session", 0, 0.5),
    span("orchestrator", "prep", "request", 0.5, 1),
    span("orchestrator", "model", "claude-opus-5-5", 1, 5),
    span("orchestrator", "tool", "subagent: fix, worker", 5, 6),
    span("orchestrator", "prep", "request", 6, 6.2),
    span("orchestrator", "model", "claude-opus-5-5", 6.2, 8),
    span("orchestrator", "wait-worker", "worker-fix", 8, 68),
    span("orchestrator", "prep", "request", 70, 70.5),
    span("orchestrator", "model", "claude-opus-5-5", 70.5, 75),
    span("orchestrator", "wait-inbox", "input", 75, 135),
    span("worker-fix", "spawn", "worker-fix", 5.5, 7.5),
    span("worker-fix", "prep", "session", 7.5, 8),
    span("worker-fix", "model", "claude-sonnet-5-5", 8, 20),
    span("worker-fix", "tool", "bash: bun test src/core", 20, 50),
    span("worker-fix", "wait-inbox", "user confirmation", 20, 25),
    span("worker-fix", "model", "claude-sonnet-5-5", 50, 60),
    span("worker-fix", "tool", "inbox: orchestrator: done", 60, 60.2),
  ];

  const total = (kinds: Record<string, number>): number => Object.values(kinds).reduce((a, b) => a + b, 0);

  test("the breakdown attributes every moment once: innermost span per agent, the busiest kind across agents, gaps as unaccounted", () => {
    const report = spanReport("c1", FIXTURE);
    expect(report.wallMs).toBe(135_000);
    expect(report.kinds).toEqual({ "model": 32_300, "tool": 26_200, "spawn": 200, "prep": 1_500, "compaction": 0, "wait-process": 0, "wait-worker": 12_800, "wait-inbox": 60_000, "unaccounted": 2_000 });
    expect(total(report.kinds)).toBe(report.wallMs);
    expect(report.activeMs).toBe(75_000);
    expect(report.nonModelMs).toBe(42_700);
    const worker = report.agents.find(agent => agent.agent === "worker-fix");
    expect(worker?.kinds).toMatchObject({ "tool": 25_200, "wait-inbox": 5_000, "model": 22_000, "spawn": 2_000, "prep": 500 });
    for (const agent of report.agents) expect(total(agent.kinds)).toBe(agent.wallMs);
    expect(report.agents.find(agent => agent.agent === "orchestrator")?.kinds.unaccounted).toBe(2_000);
    expect(report.longest.map(s => s.label).slice(0, 3)).toEqual(["worker-fix", "input", "bash: bun test src/core"]);
  });

  test("the printed breakdown leads with where the non-model time went", () => {
    expect(formatReport(spanReport("c1", FIXTURE))).toBe(EXPECTED);
    expect(formatReport(spanReport("c2", []))).toBe("conversation c2: no spans recorded\n");
  });

  const EXPECTED = `conversation c1 · wall 2m15s · active 1m15s · idle for input 1m00s
  model 32s (43% of active) · non-model 43s (57%)

  where the non-model time went:
    tool              26s   35%
    wait-worker       13s   17%
    unaccounted      2.0s    3%
    prep             1.5s    2%
    spawn           200ms    0%

  by agent (each agent's own time; waits overlap other agents' work):
    orchestrator         wall   2m15s · 10 spans · model 10s · tool 1.0s · prep 1.7s · wait-worker 1m00s · wait-inbox 1m00s · unaccounted 2.0s
    worker-fix           wall     55s · 7 spans · model 22s · tool 25s · spawn 2.0s · prep 500ms · wait-inbox 5.0s

  longest spans:
     1.   1m00s  wait-worker  orchestrator         worker-fix
     2.   1m00s  wait-inbox   orchestrator         input
     3.     30s  tool         worker-fix           bash: bun test src/core
     4.     12s  model        worker-fix           claude-sonnet-5-5
     5.     10s  model        worker-fix           claude-sonnet-5-5
     6.    5.0s  wait-inbox   worker-fix           user confirmation
     7.    4.5s  model        orchestrator         claude-opus-5-5
     8.    4.0s  model        orchestrator         claude-opus-5-5
     9.    2.0s  spawn        worker-fix           worker-fix
    10.    1.8s  model        orchestrator         claude-opus-5-5
  `;
});
