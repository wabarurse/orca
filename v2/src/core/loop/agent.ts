import type { ContentBlock, ContentBlockParam, MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { linksFor } from "../plugins/context";
import type { CompleteRequest, Provider, Turn } from "../../api";
import { restartable } from "../../api/errors";
import type { RequestSettings } from "../../api/model";
import { asRecord, errorMessage, fail, ok, type Result, usageEvent } from "../../config";
import { materialize, withImages } from "../images";
import { consume, format } from "../inbox";
import type { GuardRule } from "../tools/bash/guard";
import { ToolRefusal, type Runtime, type Tool, type ToolContext, type ToolResult } from "../tools/registry";
import { cut, flushSpans, type Spans } from "../spans";
import { toolArgs } from "../toolview";
import { closeInterrupted, type Transcript } from "../transcript";
import type { AgentEvent, Message, Role, ToolCall } from "../types";
import { type Window } from "./budget";
import { compact, type Compactor } from "./compaction";
import { appendContext } from "./context";
import { afterTool, beforeRequest, beforeTool, onInput, type LoopHooks } from "./hooks";
import type { RollingCompactor } from "./rolling";
import { budget, replyCap, requireFits } from "./budget";
import { scheduleTools } from "./schedule";

export type Resolved = { model: string; provider: Provider; settings: RequestSettings | null; contextLimit: number | null };

export type AgentSetup = {
  conversation: string;
  agent: string;
  role: Role;
  branch: string | null;
  cwd: string;
  data: string;
  trusted: boolean;
  pluginSkills: string[];
  transcript: Transcript;
  tools: Tool[];
  system: string;
  resolve: () => Promise<Result<Resolved>>;
  context: (query: string) => Promise<Record<string, string>>;
  hooks: LoopHooks;
  guard: GuardRule[];
  runtime: Runtime;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  concurrency: number;
  rolling: RollingCompactor | null;
  requireInput: boolean;
  compactRequested: () => boolean;
  spans: Spans;
};

export type RunResult = { status: "done" | "cancelled" | "failed"; text: string; error: string | null };

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;
type Prepared = { model: Resolved; estimated: number; shaped: { system: string; messages: MessageParam[]; tools: Window["tools"] }; delivered: MessageParam[] };

const RESTART_WAIT_MS = [2_000, 8_000];

export async function completeRestarting(provider: Provider, request: CompleteRequest, waits = RESTART_WAIT_MS): Promise<Turn> {
  for (let restarts = 0; ; restarts++) {
    try { return await provider.complete(request); }
    catch (error) {
      const wait = waits[restarts];
      if (wait === undefined || !restartable(error) || request.signal?.aborted === true) throw error;
      request.onNotice?.(`response interrupted (${error.reason}); asking again (${restarts + 1}/${waits.length})`);
      await Bun.sleep(wait);
    }
  }
}

const resultText = (content: ToolResult): string => typeof content === "string" ? content : content.map(block => block.type === "text" ? block.text : "[image]").join("\n");

export function createAgent(setup: AgentSetup): { run: () => Promise<RunResult> } {
  const seen = new Set<string>();
  for (const entry of setup.transcript.all()) if (entry.type === "message") for (const message of entry.inbox) seen.add(message.id);
  const window: Window = { model: "", system: setup.system, tools: setup.tools.map(tool => tool.spec), contextLimit: null, measured: null };
  const byName = new Map(setup.tools.map(tool => [tool.spec.name, tool]));
  let resolved: Resolved | null = null;
  let lastText = "";
  let failedCompaction = false;

  const notice = (text: string): void => { setup.emit({ kind: "notice", text }); };

  async function readInbox(results: ToolResultBlockParam[], all: boolean): Promise<boolean> {
    const taken = await consume(setup.conversation, setup.agent, seen, message => all || message.delivery === "steer", async messages => {
      const kept: Message[] = [];
      for (const message of messages) {
        const { message: next, dropped } = await onInput(setup.hooks, message);
        if (dropped === null) kept.push(next);
        else notice(`input dropped by ${dropped}`);
      }
      const images = kept.flatMap(message => message.images);
      const text = kept.length > 0 ? format(kept) : "";
      const turn = withImages(text, images);
      const content: MessageParam["content"] = results.length === 0 ? turn
        : [...results, ...(typeof turn === "string" ? (turn.length > 0 ? [textOnly(turn)] : []) : turn)];
      if (results.length > 0 || kept.length > 0) await setup.transcript.append({ type: "message", inbox: messages, message: { role: "user", content } });
      else await setup.transcript.append({ type: "message", inbox: messages, message: { role: "user", content: "[input withdrawn by a plugin]" } });
      if (kept.length > 0) setup.emit({ kind: "input", messages: kept });
    });
    if (taken.length === 0 && results.length > 0) await setup.transcript.append({ type: "message", inbox: [], message: { role: "user", content: results } });
    return taken.length > 0;
  }

  async function boundary(manual: boolean): Promise<Result<Resolved>> {
    setup.signal.throwIfAborted();
    await closeInterrupted(setup.transcript);
    const loaded = await setup.resolve();
    if (!loaded.ok) return loaded;
    const next = loaded.data;
    if (resolved !== null && next.model !== resolved.model) { failedCompaction = false; window.measured = null; }
    resolved = next;
    window.model = next.model;
    window.contextLimit = next.contextLimit;
    const query = [...setup.transcript.chain()].reverse().find(message => message.role === "user" && typeof message.content === "string");
    await appendContext(setup.transcript, await setup.context(typeof query?.content === "string" ? query.content.slice(-4000) : ""));
    const compacting = Date.now();
    let worked = false;
    try {
      if (setup.rolling !== null) worked = await setup.rolling.boundary({ window, provider: next.provider, signal: setup.signal, notice }, manual);
      else if (manual || !failedCompaction) {
        const compactor: Compactor = { window, provider: next.provider, settings: next.settings, transcript: setup.transcript, signal: setup.signal, trace: { conversation: setup.conversation, agent: setup.agent }, notice };
        const result = await compact(compactor, manual);
        if (result !== null) { failedCompaction = !result; worked = true; }
      }
    } finally {
      if (worked) setup.spans.begin("compaction", setup.rolling !== null ? "rolling memory" : "context", compacting, null).end({ manual: manual ? 1 : 0 });
    }
    requireFits(window, setup.transcript.chain(), "model request");
    return ok(next);
  }

  async function prepare(manual: boolean): Promise<Result<Prepared>> {
    const prep = setup.spans.begin("prep", "request", null, null);
    try {
      const loaded = await boundary(manual);
      if (!loaded.ok) return loaded;
      const messages = setup.transcript.chain();
      const estimated = budget(window, messages);
      const shaped = await beforeRequest(setup.hooks, { system: setup.system, messages, tools: window.tools });
      const delivered = await materialize(setup.conversation, shaped.messages);
      return ok({ model: loaded.data, estimated, shaped, delivered });
    } finally { prep.end({}); }
  }

  async function ask(prepared: Prepared): Promise<Turn> {
    const { model, estimated, shaped, delivered } = prepared;
    let streamed = "";
    const asking = setup.spans.begin("model", model.model, null, null);
    let turn: Turn;
    try {
      turn = await completeRestarting(model.provider, {
        signal: setup.signal,
        trace: { project: setup.conversation, agent: setup.agent, purpose: "agent" },
        cacheScope: setup.transcript.path,
        model: model.model,
        settings: model.settings ?? undefined,
        system: shaped.system,
        maxTokens: replyCap(window, shaped.messages),
        messages: delivered,
        tools: shaped.tools,
        onText: text => { streamed += text; setup.emit({ kind: "text", text }); },
        onNotice: notice,
      });
    } catch (error) {
      asking.end({ error: cut(errorMessage(error), 200) });
      throw error;
    }
    asking.end(turn.usage === undefined ? { stop: turn.stop } : { stop: turn.stop, input: turn.usage.input, output: turn.usage.output, cached: turn.usage.cachedInput ?? 0 });
    setup.signal.throwIfAborted();
    if (turn.inputTokens !== undefined) window.measured = { input: turn.inputTokens, estimated, model: model.model };
    if (turn.usage !== undefined) setup.emit({ kind: "usage", model: model.model, input: turn.usage.input, cached: turn.usage.cachedInput ?? 0, output: turn.usage.output });
    await setup.transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: turn.content } });
    const text = turn.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim();
    if (text.length > 0) lastText = text;
    else if (streamed.trim().length > 0) lastText = streamed.trim();
    return turn;
  }

  async function runTool(model: Resolved, block: ToolUse): Promise<ToolResultBlockParam> {
    const call: ToolCall = { id: block.id, name: block.name, input: block.input };
    setup.emit({ kind: "tool_start", call });
    const args = toolArgs(block.name, block.input);
    const timing = setup.spans.begin("tool", args.length > 0 ? `${block.name}: ${cut(args, 80)}` : block.name, null, block.id);
    const started = performance.now();
    try {
      const raw = asRecord(block.input) ?? {};
      let result: { ok: boolean; content: ToolResult };
      let refused: string | null = null;
      const tool = byName.get(block.name);
      if (tool === undefined) result = { ok: false, content: `unknown tool: ${block.name}` };
      else {
        const decision = await beforeTool(setup.hooks, block.name, raw, question => setup.spans.time("wait-inbox", "user confirmation", () => setup.runtime.confirm(question), yes => ({ answer: yes ? "yes" : "no" })));
        if (decision.action === "block") result = { ok: false, content: decision.reason };
        else {
          const ctx: ToolContext = { conversation: setup.conversation, agent: setup.agent, role: setup.role, branch: setup.branch, cwd: setup.cwd, data: setup.data,
            trusted: setup.trusted, pluginSkills: setup.pluginSkills, guard: setup.guard, callId: block.id, signal: setup.signal, model: model.model, provider: model.provider, settings: model.settings, runtime: setup.runtime, links: linksFor(setup.conversation, "core") };
          try {
            const content = await tool.run(decision.input, ctx);
            result = { ok: !(typeof content === "string" && content.startsWith("refused:")), content };
          } catch (error) {
            if (setup.signal.aborted) throw error;
            result = { ok: false, content: errorMessage(error) };
            if (error instanceof ToolRefusal) refused = error.rule;
          }
          if (refused === null) result = await afterTool(setup.hooks, block.name, decision.input, result);
        }
      }
      timing.end({ tool: block.name, ok: result.ok ? "yes" : "no", ...(refused === null ? {} : { refused }) });
      await usageEvent({ kind: "tool", project: setup.conversation, agent: setup.agent, tool: block.name, call: block.id, ok: result.ok, durationMs: Math.round(performance.now() - started) });
      setup.emit({ kind: "tool_end", call, outcome: { id: block.id, ok: result.ok, text: resultText(result.content) } });
      return { type: "tool_result", tool_use_id: block.id, content: result.content, ...(result.ok ? {} : { is_error: true }) };
    } finally { timing.end({ tool: block.name, ok: "interrupted" }); }
  }

  async function loop(): Promise<Result<null>> {
    const started = await readInbox([], true);
    if (setup.requireInput && !started) return ok(null);
    let pauses = 0, limits = 0;
    for (;;) {
      const prepared = await prepare(setup.compactRequested());
      if (!prepared.ok) return prepared;
      const model = prepared.data.model;
      const turn = await ask(prepared.data);
      const calls = turn.content.filter((block): block is ToolUse => block.type === "tool_use");
      if (turn.stop === "limit" && limits++ < 2) {
        notice("output limit reached; asking the model to continue in smaller pieces");
        await setup.transcript.append({ type: "message", inbox: [], message: { role: "user", content: calls.length > 0
          ? calls.map(call => ({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "not run: the response was cut off at the output limit. Re-issue this call with complete arguments, in smaller pieces if needed." }))
          : "The response reached the output limit. Continue from where it stopped, in smaller pieces." } });
        continue;
      }
      if ((turn.stop === "pause" || (turn.stop === "tool_use" && calls.length === 0)) && pauses++ < 2) {
        await setup.transcript.append({ type: "message", inbox: [], message: { role: "user", content: "Continue the existing request within its current scope." } });
        continue;
      }
      if (turn.stop === "tool_use") {
        limits = 0;
        const results = await scheduleTools(calls, call => byName.get(call.name)?.parallel(asRecord(call.input) ?? {}) ?? false,
          call => runTool(model, call), setup.concurrency);
        setup.signal.throwIfAborted();
        await readInbox(results, false);
        continue;
      }
      if (turn.stop !== "end") return fail(`model stopped (${turn.completion ?? turn.stop}); partial response kept`);
      if (await readInbox([], true)) continue;
      return ok(null);
    }
  }

  return {
    async run() {
      try {
        const outcome = await loop();
        return outcome.ok ? { status: "done", text: lastText, error: null } : { status: "failed", text: lastText, error: outcome.error };
      } catch (error) {
        if (setup.signal.aborted) return { status: "cancelled", text: lastText, error: null };
        return { status: "failed", text: lastText, error: errorMessage(error) };
      } finally {
        await flushSpans();
      }
    },
  };
}

function textOnly(text: string): ContentBlockParam {
  return { type: "text", text };
}
