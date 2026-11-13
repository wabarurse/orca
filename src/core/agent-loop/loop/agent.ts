import { usageScope } from "../../../api";
import { usageEvent } from "../../../config";
import { completeInterruptedTools } from "../../data/transcripts";
import { materializeImages } from "../../data/images";
import type { RequestSettings } from "../../../api/model";
// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set and a short role prompt (src/core/prompt/shared.ts). The task
// itself comes through the first user message (spawn's brief, or the inbox).

import type { ContentBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { projectModelResolver } from "../../data/projects";
import { workspaces } from "../../data/projects";
import { budget, compact, outputCap, replyCap, requireFits, type CompactOptions, type ContextDeps } from "../../data/memory";
import type { Tracker } from "../../tmux";
import type { ModelRequestState } from "../../tmux";
import { consume, content } from "../../data/inbox";
import type { Message } from "../../../protocol";
import type { Provider } from "../../../api";
import { sessionId } from "../../tmux";
import type { Transcript } from "../../data/transcripts";
import type { Role } from "../../../protocol";
import type { Tool, ToolContext, ToolResult } from "../../tools";
import { callText, resultText, type ToolCall, type ToolOutcome } from "../../../protocol";
import { scheduleTools } from "./tool-scheduler";
import type { RollingOptions } from "../../data/memory";
import { recordCorrection, recordRuntime } from "../../data/knowledge";
import { execution } from "../../data/projects/lifecycle";
import { Cancelled } from "../../tmux";
import { appendContext, type ContextValue } from "./context";
import { responseTiming, type ResponseTiming } from "./response-timing";

function staleExecution(deps: AgentDeps): boolean {
  return deps.ctx.executionEpoch !== undefined && execution.stale(deps.ctx.project, deps.ctx.executionEpoch);
}
function assertExecution(deps: AgentDeps): void {
  if (staleExecution(deps)) throw new Cancelled();
}

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
  loadContext?: (query: string) => Promise<ContextValue>;
  /** Captured once per safe boundary; represented by append-only transcript messages. */
  contextSnapshot?: ContextValue;
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
  tools: Record<string, Tool<ToolResult>>;
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
  if (deps.signal?.aborted || staleExecution(deps)) return { type: "tool_result", tool_use_id: "", content: "cancelled by user", is_error: true };
  const tool = deps.tools[name];
  if (!tool) return { type: "tool_result", tool_use_id: "", content: `unknown tool: ${name}`, is_error: true };
  try {
    const content = await workspaces.within(deps.ctx.project, deps.ctx.cwd, () => {
      workspaces.own(deps.ctx.project, "agent", sessionId(deps.ctx.role, deps.ctx.branch), { exclusive: true });
      return tool.run(input, { ...deps.ctx, signal: deps.signal,
        selected: deps.provider ? { model: deps.model, provider: deps.provider, settings: deps.settings } : undefined });
    });
    const refused = (name === "task" || name === "inbox") && typeof content === "string" && content.startsWith("refused:");
    return { type: "tool_result", tool_use_id: "", content, ...(refused ? { is_error: true } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: "", content: msg, is_error: true };
  }
}

/** A successful delivery to the orchestrator counts as reporting. */
function isReport(name: string, input: unknown, result: ToolResultBlockParam): boolean {
  const to = String((input as { to?: unknown } | null)?.to ?? "").trim();
  const sent = name === "message" || (name === "inbox" && (input as { action?: unknown } | null)?.action === "send");
  return sent && to === "orchestrator" && !result.is_error && String(result.content).startsWith("sent to");
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

/** A result's text for the UI; image blocks (a `read` image) are shown by their text alone. */
const resultBody = (result: ToolResultBlockParam): string => typeof result.content === "string" ? result.content
  : (result.content ?? []).map(block => block.type === "text" ? block.text : "").filter(Boolean).join("\n");

/** Preserve result order; optionally overlap independent calls between barriers. */
async function runTools(deps: AgentDeps, content: ContentBlock[], write: (t: string, plain?: boolean) => void, timing?: ResponseTiming): Promise<ToolResultBlockParam[]> {
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
    timing?.record("tool");
    const result = await runTracked(deps, block, track);
    show.end(call, { id: block.id, ok: !result.is_error, text: resultBody(result) });
    return result;
  }, deps.toolConcurrency ?? 1);
}

/** Persist payload and acknowledgements in the same transcript entry. Notification
 * follows commit; a failed append leaves the original inbox files retryable. */
async function readInbox(deps: AgentDeps, results?: ToolResultBlockParam[]): Promise<boolean> {
  assertExecution(deps);
  const msgs = await consume(deps.ctx.project, sessionId(deps.ctx.role, deps.ctx.branch), deps.transcript, async inbox => {
    assertExecution(deps);
    const blocks = content(inbox);
    await deps.transcript.append({ type: "message", inbox,
      message: { role: "user", content: results ? [...results, ...(typeof blocks === "string" ? [{ type: "text" as const, text: blocks }] : blocks)] : blocks } }, deps.signal,
      deps.ctx.executionEpoch === undefined ? undefined : { head: deps.transcript.head(), check: () => assertExecution(deps) });
    for (const message of inbox) if (message.from === "user") await recordCorrection(deps.ctx.project, { id: message.inputId ?? message.deliveryId, text: message.text, at: message.ts });
  });
  if (msgs.length) {
    deps.onInbox?.(msgs);
    await deps.tracker?.instructed();
  } else if (results) await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
  return msgs.length > 0;
}

/** One model request, streamed and appended to the transcript. */
async function ask(deps: AgentDeps, write: (t: string, plain?: boolean) => void, timing?: ResponseTiming) {
  assertExecution(deps);
  await deps.tracker?.model();
  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const observe = async (stage: ModelRequestState["stage"]) => {
    const state: ModelRequestState = { model: deps.model, provider: deps.provider?.name ?? "unknown",
      stage, startedAt, updatedAt: new Date().toISOString() };
    // Observability must not introduce a new failure/retry boundary.
    try { await deps.transcript.append({ type: "model-request", requestId, ...state }); } catch {}
    try { await deps.tracker?.request?.(state); } catch {}
    // Lifecycle evidence stays on disk; provider failures/retries and the final
    // turn error already carry actionable feedback through their existing paths.
  };
  await observe("preparing");
  const { message, estimated } = await (async () => {
    const messages = await deps.transcript.chain();
    const estimated = budget({ ...deps, compaction: undefined }, messages);
    if (deps.loadContext) await recordRuntime(deps.ctx.project, sessionId(deps.ctx.role, deps.ctx.branch), { run: deps.ctx.run, model: deps.model,
      system: deps.system ?? "", tools: Object.values(deps.tools).map(t => t.spec), contextTokens: estimated }).catch(() => {});
    if (!deps.provider) throw new Error("agent: no provider or resolver");
    const delivered = await materializeImages(deps.ctx.project, messages, deps.signal);
    const request = {
      signal: deps.signal,
      trace: { project: deps.ctx.project, agent: sessionId(deps.ctx.role, deps.ctx.branch), run: deps.ctx.run, purpose: "agent" },
      cacheScope: deps.transcript.path,
      model: deps.model,
      settings: deps.settings,
      system: deps.system,
      maxTokens: replyCap(deps, messages), // the cap, or less when the window is nearly full
      messages: delivered,
      tools: Object.values(deps.tools).map((t) => t.spec),
      onText: (t: string) => { write(t); if (t.trim()) timing?.record("text"); },
      onNotice: (t: string) => write(`${t}\n`, true),
    };
    await observe("provider-wait");
    timing?.requested();
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
    selected.contextSnapshot = await deps.loadContext(typeof last?.content === "string" ? last.content.slice(-4000) : "");
    await appendContext(deps.transcript, selected.contextSnapshot, deps.signal, { head: deps.transcript.head(), check: () => assertExecution(deps) });
  }
  const configured = { ...selected, requestOutputCap: outputCap(selected) };
  deps.onContext?.(configured);
  return configured;
}
function boundaries(deps: AgentDeps) {
  let failed = false;
  let previousModel = "";
  return async (manual = false, maintenance = false): Promise<AgentDeps> => {
    assertExecution(deps);
    deps.signal?.throwIfAborted();
    await completeInterruptedTools(deps.transcript, deps.signal);
    const current = await snapshot(deps);
    assertExecution(current);
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
    // Compaction may have summarized the previous snapshot. Restore current
    // reference context once if it is absent from the retained tail.
    if (current.contextSnapshot !== undefined) await appendContext(current.transcript, current.contextSnapshot, current.signal,
      { head: current.transcript.head(), check: () => assertExecution(current) });
    if (!maintenance) requireFits(current, await current.transcript.chain(), outputCap(current), "model request");
    return current;
  };
}
async function toolBatch(deps: AgentDeps, content: ContentBlock[], timing?: ResponseTiming): Promise<boolean> {
  const results = await runTools(deps, content, deps.write!, timing);
  if (!deps.signal?.aborted && !staleExecution(deps)) {
    try {
      const receivedInput = await readInbox(deps, results);
      const calls = content.filter((block): block is ToolUse => block.type === "tool_use");
      return !receivedInput && calls.length > 0 && calls.every((call, i) => {
        const action = (call.input as Record<string, unknown> | null)?.action;
        const result = results[i];
        return call.name === "task" && (action === "create" || action === "register") &&
          result?.is_error === true && typeof result.content === "string" && result.content.startsWith("refused: tasks:");
      });
    }
    catch (error) { if (!(error instanceof Cancelled)) throw error; }
  }
  // Preserve completed results without consuming input authorized for a new run.
  await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
  return false;
}
/** Consecutive output-limit stops answered before the turn fails as it always did. */
const LIMIT_RECOVERIES = 2;
/** A response cut off at the output limit. Its tool calls may carry truncated arguments, so
 * none runs: each gets an error result asking for a complete call (as pi does); text alone
 * gets a request to resume in smaller pieces (as Claude Code does). The transcript stays valid. */
async function resumeAfterLimit(deps: AgentDeps, content: ContentBlock[]): Promise<void> {
  const cut = "The response reached the output limit and was cut off.";
  const calls = content.filter((block): block is ToolUse => block.type === "tool_use");
  deps.write!("output limit reached; asking the model to continue in smaller pieces\n", true);
  await deps.transcript.append({ type: "message", message: { role: "user", content: calls.length
    ? calls.map(call => ({ type: "tool_result" as const, tool_use_id: call.id, is_error: true,
      content: `not run: ${cut} Re-issue this call with complete arguments, in smaller pieces if needed.` }))
    : `${cut} Resume directly from where it stopped, without apology or recap, and break the remaining work into smaller pieces.` } });
}
async function runLoop(deps: AgentDeps, boundary: ReturnType<typeof boundaries>, timing?: ResponseTiming): Promise<void> {
  deps.signal?.throwIfAborted();
  const consumed = await readInbox(deps);
  if (deps.requireInbox && !consumed) return;
  let pauses = 0;
  let limits = 0;
  let refusedTaskBatches = 0;
  for (;;) {
    const current = await boundary(deps.compactRequested?.() ?? false);
    deps.signal?.throwIfAborted();
    const message = await ask(current, deps.write!, timing);
    if (message.stop === "limit" && ++limits <= LIMIT_RECOVERIES) { await resumeAfterLimit(current, message.content); continue; }
    if (message.stop === "tool_use") {
      limits = 0;
      refusedTaskBatches = await toolBatch(current, message.content, timing) ? refusedTaskBatches + 1 : 0;
      if (refusedTaskBatches >= 3) {
        throw new Error("task creation stopped after three batches of validation errors. Existing tasks were kept. Check the task list before retrying with corrected fields");
      }
      continue;
    }
    if (message.stop === "pause" && !message.content.some(block => block.type === "tool_use") && ++pauses <= 2) {
      await deps.transcript.append({ type: "message", message: { role: "user", content: "The provider paused this response. Continue the existing request within its current scope." } });
      continue;
    }
    if (message.stop !== "end") throw new Error(`model stopped (${message.completion ?? message.stop}); partial response retained, task completion is not established`);
    deps.signal?.throwIfAborted();
    if (await readInbox(deps)) { refusedTaskBatches = 0; continue; }
    if (deps.compactRequested?.()) await boundary(true);
    return;
  }
}
/** Sole-writer loop; status and model output share the normalized scoped writer. */
export function createAgent(input: AgentDeps) {
  const deps = { ...input, compaction: input.compaction ?? {}, write: input.write ?? ((t: string) => { process.stdout.write(t); }) };
  const boundary = boundaries(deps);
  const run = async () => {
    if (deps.ctx.role !== "orchestrator") return runLoop(deps, boundary);
    const timing = responseTiming(deps.ctx.project);
    const current = { ...deps, onInbox(messages: Message[]) { timing.consumed(messages); deps.onInbox?.(messages); } };
    let outcome: "settled" | "cancelled" | "failed" = "settled";
    try { await runLoop(current, boundary, timing); }
    catch (error) { outcome = deps.signal?.aborted ? "cancelled" : "failed"; throw error; }
    finally { await timing.finish(outcome); }
  };
  return { run, compact: async () => { await boundary(true); }, maintain: async () => { await boundary(false, true); } };
}
