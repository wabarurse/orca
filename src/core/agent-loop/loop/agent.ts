import { usageScope, usageEvent } from "../../../providers";
import { completeInterruptedTools } from "../../data/transcripts";
import { modelRequestText } from "../../../protocol";
import { materializeImages } from "../../data/images";
import type { RequestSettings } from "../../../providers/catalog";
// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set and a short role prompt (src/core/prompt/shared.ts). The task
// itself comes through the first user message (spawn's brief, or the inbox).

import type { ContentBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { projectModelResolver } from "../../data/projects";
import { budget, compact, outputCap, requireFits, type CompactOptions, type ContextDeps } from "../../data/memory";
import type { Tracker } from "../../tmux";
import type { ModelRequestState } from "../../tmux";
import { consume, content } from "../../data/inbox";
import type { Message } from "../../../protocol";
import type { Provider } from "../../../providers";
import { sessionId } from "../../tmux";
import type { Transcript } from "../../data/transcripts";
import type { Role } from "../../../protocol";
import type { Tool, ToolContext } from "../../tools";
import { callText, resultText, type ToolCall, type ToolOutcome } from "../../../protocol";
import { scheduleTools } from "./tool-scheduler";
import type { RollingOptions } from "../../data/memory";
import { recordCorrection, recordRuntime } from "../../data/knowledge";

export interface AgentOptions {
  project: string;
  role: Role;
  branch?: string;
  /** Run id from agentCommand, shared with the shell follow-up; random when absent. */
  run?: string;
  /** Injectable credentials boundary; production defaults to accounts.provider. */
  loadProvider?: Parameters<typeof projectModelResolver>[1];
  rolling?: RollingOptions;
  /** Orchestrator only: stop the daemon once nothing is pending instead of waiting for more (probes and tests). */
  exitWhenIdle?: boolean;
}

export interface AgentDeps extends ContextDeps {
  loadContext?: (query: string) => Promise<string>;
  /** UI observer of the actual safe-boundary request configuration. */
  onContext?: (deps: AgentDeps) => void;
  /** Maximum overlap of calls explicitly marked independent. Other tools are barriers. */
  toolConcurrency?: number;
  /** An orchestrator must never resume historical context without fresh input. */
  requireInbox?: boolean;
  signal?: AbortSignal;
  provider?: Provider;
  settings?: RequestSettings;
  /** Internal safe-boundary snapshot: request output cap and accounting reserve. */
  requestOutputCap?: number;
  compaction?: CompactOptions;
  compactRequested?: () => boolean;
  /** Orchestrator-owned background memory, invoked only between complete tool batches. */
  compactBoundary?: (current: AgentDeps, manual: boolean, maintenance?: boolean) => Promise<void>;
  /** Resolve before budgeting, not just before the normal request. */
  resolveModel?: () => Promise<{ model: string; provider: Provider; settings?: RequestSettings }>;
  transcript: Transcript;
  tools: Record<string, Tool>;
  model: string;
  /** System prompt for the role; omitted in tests. */
  system?: string;
  ctx: ToolContext;
  /** Where streamed text goes; defaults to stdout. `plain` marks tool lines (not model markdown). */
  write?: (text: string, plain?: boolean) => void;
  /** Records steps and reports for exit notices (src/core/tmux/exits.ts); absent for the orchestrator and in most tests. */
  tracker?: Tracker;
  /** Each batch of inbox messages after its context and exact identities are durably committed (the TUI shows them). */
  onInbox?: (msgs: Message[]) => void;
  /** A tool call starting and ending (the TUI shows it running, then its line and summary). Without them, `write` gets the "⏺" line and its "⎿" summary as plain lines. */
  onTool?: (call: ToolCall) => void;
  onToolResult?: (outcome: ToolOutcome, call: ToolCall) => void;
}


type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** Run one tool; a thrown error becomes an is_error result, never a crash. */
async function runTool(deps: AgentDeps, name: string, input: Record<string, unknown>): Promise<ToolResultBlockParam> {
  if (deps.signal?.aborted) return { type: "tool_result", tool_use_id: "", content: "cancelled by user", is_error: true };
  const tool = deps.tools[name];
  if (!tool) return { type: "tool_result", tool_use_id: "", content: `unknown tool: ${name}`, is_error: true };
  try {
    return { type: "tool_result", tool_use_id: "", content: await tool.run(input, { ...deps.ctx, signal: deps.signal,
      selected: deps.provider ? { model: deps.model, provider: deps.provider, settings: deps.settings } : undefined }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: "", content: msg, is_error: true };
  }
}

/** A successful `message` to the orchestrator: what counts as reporting. */
function isReport(name: string, input: unknown, result: ToolResultBlockParam): boolean {
  const to = String((input as { to?: unknown } | null)?.to ?? "").trim();
  return name === "message" && to === "orchestrator" && !result.is_error && String(result.content).startsWith("sent to");
}

/** Run one tool call and tell the tracker: the step before, a report after. */
async function runTracked(deps: AgentDeps, block: ToolUse, track: (name: string, input: unknown) => Promise<void>): Promise<ToolResultBlockParam> {
  const input = block.input as Record<string, unknown>;
  // Run tracking that cannot be recorded (e.g. task state stayed locked) refuses this call, never ends the run.
  try { await track(block.name, input); }
  catch (err) {
    if (deps.signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: block.id, content: `not run: ${msg}; nothing was changed, retry the call`, is_error: true };
  }
  const started = performance.now();
  const trace = { project: deps.ctx.project, agent: sessionId(deps.ctx.role, deps.ctx.branch), run: deps.ctx.run };
  const result = await usageScope(trace, () => runTool({ ...deps, ctx: { ...deps.ctx, callId: block.id } }, block.name, input));
  await usageEvent({ kind: "tool", ...trace, tool: block.name, call: block.id, ok: !result.is_error, durationMs: performance.now() - started });
  if (isReport(block.name, input, result)) await deps.tracker?.reported();
  return { ...result, tool_use_id: block.id };
}

/** Show a call starting and ending: through onTool/onToolResult, else as plain lines to `write`. */
function echo(deps: AgentDeps, write: (t: string, plain?: boolean) => void) {
  return {
    start: (call: ToolCall) => (deps.onTool ? deps.onTool(call) : write(`${callText(call)}\n`, true)),
    end: (call: ToolCall, outcome: ToolOutcome) =>
      deps.onToolResult ? deps.onToolResult(outcome, call) : write(`${resultText(call.name, outcome)}\n`, true),
  };
}

/** Preserve result order; optionally overlap independent calls between barriers. */
async function runTools(deps: AgentDeps, content: ContentBlock[], write: (t: string, plain?: boolean) => void): Promise<ToolResultBlockParam[]> {
  const show = echo(deps, write);
  // Run-state writes still have one writer even when tool execution overlaps.
  let tracking = Promise.resolve();
  const track = (name: string, input: unknown) => {
    // A failed step must not reject every later one: each call waits for, not inherits, the previous outcome.
    const step = tracking.catch(() => {}).then(() => deps.tracker?.tool(name, input));
    tracking = step;
    return step;
  };
  const calls = content.filter((b): b is ToolUse => b.type === "tool_use");
  return scheduleTools(calls, b => deps.tools[b.name]?.parallel?.(b.input as Record<string, unknown>) ?? false, async block => {
    const call: ToolCall = { id: block.id, name: block.name, input: block.input };
    show.start(call);
    const result = await runTracked(deps, block, track);
    show.end(call, { id: block.id, ok: !result.is_error, text: String(result.content ?? "") });
    return result;
  }, deps.toolConcurrency ?? 1);
}

/** Persist payload and acknowledgements in the same transcript entry. Notification
 * follows commit; a failed append leaves the original inbox files retryable. */
async function readInbox(deps: AgentDeps, results?: ToolResultBlockParam[]): Promise<boolean> {
  const msgs = await consume(deps.ctx.project, sessionId(deps.ctx.role, deps.ctx.branch), deps.transcript, async inbox => {
    const blocks = content(inbox);
    await deps.transcript.append({ type: "message", inbox,
      message: { role: "user", content: results ? [...results, ...(typeof blocks === "string" ? [{ type: "text" as const, text: blocks }] : blocks)] : blocks } });
    for (const message of inbox) if (message.from === "user") await recordCorrection(deps.ctx.project, { id: message.inputId ?? message.deliveryId, text: message.text, at: message.ts });
  });
  if (msgs.length) {
    deps.onInbox?.(msgs);
    await deps.tracker?.instructed();
  } else if (results) await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
  return msgs.length > 0;
}

/** One model request, streamed and appended to the transcript. */
async function ask(deps: AgentDeps, write: (t: string, plain?: boolean) => void) {
  await deps.tracker?.model();
  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const observe = async (stage: ModelRequestState["stage"]) => {
    const state: ModelRequestState = { model: deps.model, provider: deps.provider?.name ?? "unknown",
      stage, startedAt, updatedAt: new Date().toISOString() };
    // Observability must not introduce a new failure/retry boundary.
    try { await deps.transcript.append({ type: "model-request", requestId, ...state }); } catch {}
    try { await deps.tracker?.request?.(state); } catch {}
    try { write(`${modelRequestText(state)}\n`, true); } catch {}
  };
  await observe("preparing");
  const { message, estimated } = await (async () => {
    const messages = await deps.transcript.chain();
    const estimated = budget({ ...deps, compaction: undefined }, messages);
    if (deps.loadContext) await recordRuntime(deps.ctx.project, sessionId(deps.ctx.role, deps.ctx.branch), { run: deps.ctx.run, model: deps.model,
      system: deps.system ?? "", tools: Object.values(deps.tools).map(t => t.spec), contextTokens: estimated }).catch(() => {});
    if (!deps.provider) throw new Error("agent: no provider or resolver");
    const delivered = await materializeImages(deps.ctx.project, messages);
    const request = {
      signal: deps.signal,
      trace: { project: deps.ctx.project, agent: sessionId(deps.ctx.role, deps.ctx.branch), run: deps.ctx.run, purpose: "agent" },
      model: deps.model,
      settings: deps.settings,
      system: deps.system,
      maxTokens: outputCap(deps),
      messages: delivered,
      tools: Object.values(deps.tools).map((t) => t.spec),
      onText: (t: string) => write(t),
      onNotice: (t: string) => write(`${t}\n`, true),
    };
    await observe("provider-wait");
    const message = await deps.provider.complete(request);
    deps.signal?.throwIfAborted();
    if (message.content.some((b) => b.type === "text")) write("\n");
    await observe("completed");
    return { message, estimated };
  })().catch(async (error: unknown) => {
    await observe(deps.signal?.aborted ? "aborted" : "error");
    throw error;
  });
  if (message.inputTokens !== undefined) {
    deps.compaction ??= {};
    deps.compaction.measured = { input: message.inputTokens, estimated, model: deps.model };
  }
  await deps.transcript.append({ type: "message", message: { role: "assistant", content: message.content } });
  return message;
}

/** Resolve credentials/settings exactly once at a safe boundary. Failure never falls back. */
async function snapshot(deps: AgentDeps): Promise<AgentDeps> {
  const current = deps.resolveModel ? await deps.resolveModel() : { model: deps.model, provider: deps.provider, settings: deps.settings };
  if (!current.provider) throw new Error("agent: no provider or resolver");
  const selected = { ...deps, ...current, settings: current.settings ? { ...current.settings } : undefined };
  if (deps.loadContext) {
    const messages = await deps.transcript.chain();
    const last = messages.filter(m => m.role === "user" && typeof m.content === "string").at(-1);
    selected.system = [deps.system, await deps.loadContext(typeof last?.content === "string" ? last.content.slice(-4000) : "")].filter(Boolean).join("\n\n");
  }
  const configured = { ...selected, requestOutputCap: outputCap(selected) };
  deps.onContext?.(configured);
  return configured;
}
function boundaries(deps: AgentDeps) {
  let failed = false;
  let previousModel = "";
  return async (manual = false, maintenance = false): Promise<AgentDeps> => {
    deps.signal?.throwIfAborted();
    await completeInterruptedTools(deps.transcript, deps.signal);
    const current = await snapshot(deps);
    deps.signal?.throwIfAborted();
    if (current.model !== previousModel) failed = false;
    previousModel = current.model;
    if (current.compactBoundary) await current.compactBoundary(current, manual, maintenance);
    else if (!maintenance && (manual || !failed)) {
      try {
        const result = await compact(current, manual);
        if (result !== null) failed = !result;
      } catch (error) { failed = true; throw error; }
    }
    if (!maintenance) requireFits(current, await current.transcript.chain(), outputCap(current), "model request");
    return current;
  };
}
async function toolBatch(deps: AgentDeps, content: ContentBlock[]): Promise<void> {
  const results = await runTools(deps, content, deps.write!);
  if (!deps.signal?.aborted) await readInbox(deps, results);
  else await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
}
async function runLoop(deps: AgentDeps, boundary: ReturnType<typeof boundaries>): Promise<void> {
  deps.signal?.throwIfAborted();
  const consumed = await readInbox(deps);
  if (deps.requireInbox && !consumed) return;
  let pauses = 0;
  for (;;) {
    const current = await boundary(deps.compactRequested?.() ?? false);
    deps.signal?.throwIfAborted();
    const message = await ask(current, deps.write!);
    if (message.stop === "tool_use") { await toolBatch(current, message.content); continue; }
    if (message.stop === "pause" && !message.content.some(block => block.type === "tool_use") && ++pauses <= 2) {
      await deps.transcript.append({ type: "message", message: { role: "user", content: "The provider paused this response. Continue the existing request within its current scope." } });
      continue;
    }
    if (message.stop !== "end") throw new Error(`model stopped (${message.completion ?? message.stop}); partial response retained, task completion is not established`);
    deps.signal?.throwIfAborted();
    if (await readInbox(deps)) continue;
    if (deps.compactRequested?.()) await boundary(true);
    return;
  }
}
/** Sole-writer loop; status and model output share the normalized scoped writer. */
export function createAgent(input: AgentDeps) {
  const deps = { ...input, compaction: input.compaction ?? {}, write: input.write ?? ((t: string) => { process.stdout.write(t); }) };
  const boundary = boundaries(deps);
  return { run: () => runLoop(deps, boundary), compact: async () => { await boundary(true); }, maintain: async () => { await boundary(false, true); } };
}
