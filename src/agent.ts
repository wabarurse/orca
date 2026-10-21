import type { RequestSettings } from "./project-settings";
// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set and a short role prompt (src/prompts.ts). The task
// itself comes through the first user message (spawn's brief, or the inbox).

import type { ContentBlock, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { effectiveModel, projectModelResolver } from "./project-model";
import { loadConfig, paths } from "./config";
import { supervise, type Tracker } from "./exits";
import { drain, format, type Message } from "./inbox";
import { rolePrompt } from "./prompts";
import { type Provider } from "./providers/index";
import { sessionId } from "./runner";
import { open, type Role, type Transcript } from "./transcript";
import { registry, toolsFor, type Tool, type ToolContext } from "./tools/index";
import { toolLine } from "./view";

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
  provider?: Provider;
  /** Resolve the project setting immediately before every model request. */
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
}

const MAX_TOKENS = 64000;

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** Run one tool; a thrown error becomes an is_error result, never a crash. */
async function runTool(deps: AgentDeps, name: string, input: Record<string, unknown>): Promise<ToolResultBlockParam> {
  const tool = deps.tools[name];
  if (!tool) return { type: "tool_result", tool_use_id: "", content: `unknown tool: ${name}`, is_error: true };
  try {
    return { type: "tool_result", tool_use_id: "", content: await tool.run(input, deps.ctx) };
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
async function runTracked(deps: AgentDeps, block: ToolUse): Promise<ToolResultBlockParam> {
  const input = block.input as Record<string, unknown>;
  await deps.tracker?.tool(block.name, input);
  const result = await runTool(deps, block.name, input);
  if (isReport(block.name, input, result)) await deps.tracker?.reported();
  return { ...result, tool_use_id: block.id };
}

/** Run a turn's tool calls in order, echoing each one. */
async function runTools(deps: AgentDeps, content: ContentBlock[], write: (t: string, plain?: boolean) => void): Promise<ToolResultBlockParam[]> {
  const results: ToolResultBlockParam[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    write(`${toolLine(block.name, block.input)}\n`, true);
    results.push(await runTracked(deps, block));
  }
  return results;
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
  const current = deps.resolveModel ? await deps.resolveModel() : { model: deps.model, provider: deps.provider!, settings: undefined };
  const message = await current.provider.complete({
    model: current.model,
    settings: current.settings,
    system: deps.system,
    maxTokens: MAX_TOKENS,
    messages: await deps.transcript.chain(),
    tools: Object.values(deps.tools).map((t) => t.spec),
    onText: (t) => write(t),
  });
  if (message.content.some((b) => b.type === "text")) write("\n");
  await deps.transcript.append({ type: "message", message: { role: "assistant", content: message.content } });
  return message;
}

/** Build the loop from explicit dependencies. `runAgent` wires the real ones. */
export function createAgent(deps: AgentDeps) {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));

  /**
   * Run until the model ends a turn with an empty inbox. Messages are never
   * injected mid-step: a tool call always finishes first, then anything that
   * arrived meanwhile is delivered in the same user turn as the tool results,
   * so the model sees it before deciding its next step. Messages that arrive
   * after a turn ends start another, so a worker that gets a note from the
   * orchestrator keeps going instead of exiting.
   */
  async function run(): Promise<void> {
    await readInbox(deps);
    for (;;) {
      const message = await ask(deps, write);
      if (message.stop !== "tool_use") {
        if (await readInbox(deps)) continue;
        return;
      }
      const results = await runTools(deps, message.content, write);
      // Queued messages ride along after the tool results; they never cut a tool short.
      const note = await inboxBlock(deps);
      await deps.transcript.append({ type: "message", message: { role: "user", content: note ? [...results, note] : results } });
    }
  }

  return { run };
}

/**
 * Run an agent process. Workers and reviewers are supervised: a crash or an
 * exit without a report sends an `[agent-exit]` notice to the orchestrator.
 * Returns the process exit code.
 */
export async function runAgent(opts: AgentOptions): Promise<number> {
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
  return supervise(info, (tracker) => startAgent(opts, tracker));
}

async function startAgent(opts: AgentOptions, tracker?: Tracker): Promise<void> {
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
    resolveModel: projectModelResolver(opts.project, opts.loadProvider),
    transcript,
    tools,
    model,
    system: rolePrompt(opts.role, config),
    ctx: { project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
    tracker,
  });
  await agent.run();
}
