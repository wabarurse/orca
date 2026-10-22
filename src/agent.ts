import { publishLaunch, watchCancellation } from "./cancellation";
import type { RequestSettings } from "./project-settings";
// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set and a short role prompt (src/prompts.ts). The task
// itself comes through the first user message (spawn's brief, or the inbox).

import type { ContentBlock, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { effectiveModel, projectModelResolver } from "./project-model";
import { budget, compact, outputCap, requireFits, type CompactOptions } from "./compaction";
import { loadConfig, paths } from "./config";
import { supervise, type Tracker } from "./exits";
import { drain, format, type Message } from "./inbox";
import { rolePrompt } from "./prompts";
import { type Provider } from "./providers/index";
import { sessionId } from "./runner";
import { open, type Role, type Transcript } from "./transcript";
import { registry, toolsFor, type Tool, type ToolContext } from "./tools/index";
import { callText, resultText, type ToolCall, type ToolOutcome } from "./toolview";
import { scheduleTools } from "./tool-scheduler";

export interface AgentOptions {
  project: string;
  role: Role;
  branch?: string;
  /** Run id from agentCommand, shared with the shell follow-up; random when absent. */
  run?: string;
  /** Injectable credentials boundary; production defaults to accounts.provider. */
  loadProvider?: Parameters<typeof projectModelResolver>[1];
}

export interface AgentDeps {
  /** Maximum overlap of calls explicitly marked independent. Other tools are barriers. */
  toolConcurrency?: number;
  signal?: AbortSignal;
  provider?: Provider;
  settings?: RequestSettings;
  /** Internal safe-boundary snapshot: request output cap and accounting reserve. */
  requestOutputCap?: number;
  compaction?: CompactOptions;
  compactRequested?: () => boolean;
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
  /** Records steps and reports for exit notices (src/exits.ts); absent for the orchestrator and in most tests. */
  tracker?: Tracker;
  /** Each batch of inbox messages as it is read, before it reaches the transcript (the TUI shows them). */
  onInbox?: (msgs: Message[]) => void;
  /** A tool call starting and ending (the TUI shows it running, then its line and summary). Without them, `write` gets the "⏺" line and its "⎿" summary as plain lines. */
  onTool?: (call: ToolCall) => void;
  onToolResult?: (outcome: ToolOutcome) => void;
}


type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** Run one tool; a thrown error becomes an is_error result, never a crash. */
async function runTool(deps: AgentDeps, name: string, input: Record<string, unknown>): Promise<ToolResultBlockParam> {
  if (deps.signal?.aborted) return { type: "tool_result", tool_use_id: "", content: "Cancelled by user", is_error: true };
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
  await track(block.name, input);
  const result = await runTool(deps, block.name, input);
  if (isReport(block.name, input, result)) await deps.tracker?.reported();
  return { ...result, tool_use_id: block.id };
}

/** Show a call starting and ending: through onTool/onToolResult, else as plain lines to `write`. */
function echo(deps: AgentDeps, write: (t: string, plain?: boolean) => void) {
  return {
    start: (call: ToolCall) => (deps.onTool ? deps.onTool(call) : write(`${callText(call)}\n`, true)),
    end: (call: ToolCall, outcome: ToolOutcome) =>
      deps.onToolResult ? deps.onToolResult(outcome) : write(`${resultText(call.name, outcome)}\n`, true),
  };
}

/** Preserve result order; optionally overlap independent calls between barriers. */
async function runTools(deps: AgentDeps, content: ContentBlock[], write: (t: string, plain?: boolean) => void): Promise<ToolResultBlockParam[]> {
  const show = echo(deps, write);
  // Run-state writes still have one writer even when tool execution overlaps.
  let tracking = Promise.resolve();
  const track = (name: string, input: unknown) => {
    tracking = tracking.then(() => deps.tracker?.tool(name, input));
    return tracking;
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

/** Waiting inbox messages as one text block, or null when there are none. New messages mean new instructions. */
async function inboxBlock(deps: AgentDeps): Promise<TextBlockParam | null> {
  const msgs = await drain(deps.ctx.project, sessionId(deps.ctx.role, deps.ctx.branch));
  if (!msgs.length) return null;
  deps.onInbox?.(msgs);
  await deps.tracker?.instructed();
  return { type: "text", text: format(msgs) };
}

/** Move waiting inbox messages into the transcript as one user turn. */
async function readInbox(deps: AgentDeps): Promise<boolean> {
  const block = await inboxBlock(deps);
  if (!block) return false;
  await deps.transcript.append({ type: "message", message: { role: "user", content: block.text } });
  return true;
}

/** One model request, streamed and appended to the transcript. */
async function ask(deps: AgentDeps, write: (t: string, plain?: boolean) => void) {
  await deps.tracker?.model();
  const messages = await deps.transcript.chain();
  const estimated = budget({ ...deps, compaction: undefined }, messages);
  if (!deps.provider) throw new Error("agent: no provider or resolver");
  const message = await deps.provider.complete({
    signal: deps.signal,
    model: deps.model,
    settings: deps.settings,
    system: deps.system,
    maxTokens: outputCap(deps),
    messages,
    tools: Object.values(deps.tools).map((t) => t.spec),
    onText: (t) => write(t),
  });
  deps.signal?.throwIfAborted();
  if (message.inputTokens !== undefined) {
    deps.compaction ??= {};
    deps.compaction.measured = { input: message.inputTokens, estimated, model: deps.model };
  }
  if (message.content.some((b) => b.type === "text")) write("\n");
  await deps.transcript.append({ type: "message", message: { role: "assistant", content: message.content } });
  return message;
}

/** Resolve credentials/settings exactly once at a safe boundary. Failure never falls back. */
async function snapshot(deps: AgentDeps): Promise<AgentDeps> {
  const current = deps.resolveModel ? await deps.resolveModel() : { model: deps.model, provider: deps.provider, settings: deps.settings };
  if (!current.provider) throw new Error("agent: no provider or resolver");
  const selected = { ...deps, ...current, settings: current.settings ? { ...current.settings } : undefined };
  return { ...selected, requestOutputCap: outputCap(selected) };
}
function boundaries(deps: AgentDeps) {
  let failed = false;
  let previousModel = "";
  return async (manual = false): Promise<AgentDeps> => {
    deps.signal?.throwIfAborted();
    const current = await snapshot(deps);
    deps.signal?.throwIfAborted();
    if (current.model !== previousModel) failed = false;
    previousModel = current.model;
    if (manual || !failed) {
      try {
        const result = await compact(current, manual);
        if (result !== null) failed = !result;
      } catch (error) { failed = true; throw error; }
    }
    requireFits(current, await current.transcript.chain(), outputCap(current), "model request");
    return current;
  };
}
async function toolBatch(deps: AgentDeps, content: ContentBlock[]): Promise<void> {
  const results = await runTools(deps, content, deps.write!);
  const note = deps.signal?.aborted ? null : await inboxBlock(deps);
  await deps.transcript.append({ type: "message", message: { role: "user", content: note ? [...results, note] : results } });
}
async function runLoop(deps: AgentDeps, boundary: ReturnType<typeof boundaries>): Promise<void> {
  deps.signal?.throwIfAborted();
  await readInbox(deps);
  for (;;) {
    const current = await boundary(deps.compactRequested?.() ?? false);
    deps.signal?.throwIfAborted();
    const message = await ask(current, deps.write!);
    if (message.stop === "tool_use") { await toolBatch(current, message.content); continue; }
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
  return { run: () => runLoop(deps, boundary), compact: async () => { await boundary(true); } };
}

/**
 * Run an agent process. Workers and reviewers are supervised: a crash or an
 * exit without a report sends an `[agent-exit]` notice to the orchestrator.
 * Returns the process exit code.
 */
export async function runAgent(opts: AgentOptions): Promise<number> {
  const run = opts.run ?? crypto.randomUUID();
  if (!opts.run) publishLaunch(opts.project, sessionId(opts.role, opts.branch), run);
  opts = { ...opts, run };
  if (opts.role === "orchestrator" || !opts.branch) {
    await startAgent(opts);
    return 0;
  }
  const info = {
    project: opts.project,
    id: sessionId(opts.role, opts.branch),
    run: opts.run || crypto.randomUUID().slice(0, 8),
    role: opts.role,
    branch: opts.branch,
    cwd: process.cwd(),
  };
  return supervise(info, (tracker) => startAgent({ ...opts, run: info.run }, tracker));
}

async function startAgent(opts: AgentOptions, tracker?: Tracker): Promise<void> {
  const cancellation = new AbortController();
  const unwatch = watchCancellation(opts.project, sessionId(opts.role, opts.branch), cancellation, opts.run!);
  try { await agentSession(opts, cancellation.signal, tracker); }
  catch (error) { throw cancellation.signal.aborted ? cancellation.signal.reason : error; }
  finally { unwatch(); }
}

async function agentSession(opts: AgentOptions, signal: AbortSignal, tracker?: Tracker): Promise<void> {
  const config = await loadConfig();
  const model = await effectiveModel(opts.project);
  // One transcript per role per branch, so a restart resumes it. spawn seeds
  // it with the prompt before starting this process.
  const transcript = open(paths.transcript(opts.project, sessionId(opts.role, opts.branch)));
  if (transcript.head() === null) {
    if (opts.branch) throw new Error(`agent: no transcript for ${sessionId(opts.role, opts.branch)}; spawn seeds it`);
    await transcript.append({ type: "meta", role: opts.role, model });
  }

  const tools: Record<string, Tool> = {};
  for (const name of toolsFor[opts.role]) {
    const tool = registry[name];
    if (tool) tools[name] = tool;
  }

  const agent = createAgent({
    signal,
    toolConcurrency: config.toolConcurrency,
    resolveModel: projectModelResolver(opts.project, opts.loadProvider),
    transcript,
    tools,
    model,
    compaction: { enabled: config.compact, fallback: config.contextLimitFallback },
    system: rolePrompt(opts.role, config),
    ctx: { run: opts.run, project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
    tracker,
  });
  await agent.run();
}
