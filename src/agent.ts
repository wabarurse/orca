// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set and a short role prompt (src/prompts.ts). The task
// itself comes through the first user message (spawn's brief, or the inbox).

import type { TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { provider as providerFromAccounts } from "./accounts";
import { loadConfig, paths } from "./config";
import { drain, format } from "./inbox";
import { rolePrompt } from "./prompts";
import { providerFor, type Provider } from "./providers/index";
import { sessionId } from "./runner";
import { open, type Role, type Transcript } from "./transcript";
import { registry, toolsFor, type Tool, type ToolContext } from "./tools/index";

export interface AgentOptions {
  project: string;
  role: Role;
  branch?: string;
}

export interface AgentDeps {
  provider: Provider;
  transcript: Transcript;
  tools: Record<string, Tool>;
  model: string;
  /** System prompt for the role; omitted in tests. */
  system?: string;
  ctx: ToolContext;
  /** Where streamed text goes; defaults to stdout. `plain` marks tool lines (not model markdown). */
  write?: (text: string, plain?: boolean) => void;
}

const MAX_TOKENS = 64000;

/** Build the loop from explicit dependencies. `runAgent` wires the real ones. */
export function createAgent(deps: AgentDeps) {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const tools = Object.values(deps.tools).map((t) => t.spec);

  async function runTool(name: string, input: Record<string, unknown>): Promise<ToolResultBlockParam> {
    const tool = deps.tools[name];
    if (!tool) return { type: "tool_result", tool_use_id: "", content: `unknown tool: ${name}`, is_error: true };
    try {
      return { type: "tool_result", tool_use_id: "", content: await tool.run(input, deps.ctx) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: "tool_result", tool_use_id: "", content: msg, is_error: true };
    }
  }

  const me = sessionId(deps.ctx.role, deps.ctx.branch);

  /** Waiting inbox messages as one text block, or null when there are none. */
  async function inboxBlock(): Promise<TextBlockParam | null> {
    const msgs = await drain(deps.ctx.project, me);
    return msgs.length ? { type: "text", text: format(msgs) } : null;
  }

  /** Move waiting inbox messages into the transcript as one user turn. */
  async function readInbox(): Promise<boolean> {
    const block = await inboxBlock();
    if (!block) return false;
    await deps.transcript.append({ type: "message", message: { role: "user", content: block.text } });
    return true;
  }

  /**
   * Run until the model ends a turn with an empty inbox. Messages are never
   * injected mid-step: a tool call always finishes first, then anything that
   * arrived meanwhile is delivered in the same user turn as the tool results,
   * so the model sees it before deciding its next step. Messages that arrive
   * after a turn ends start another, so a worker that gets a note from the
   * orchestrator keeps going instead of exiting.
   */
  async function run(): Promise<void> {
    await readInbox();
    for (;;) {
      const message = await deps.provider.complete({
        model: deps.model,
        system: deps.system,
        maxTokens: MAX_TOKENS,
        messages: await deps.transcript.chain(),
        tools,
        onText: (t) => write(t),
      });
      if (message.content.some((b) => b.type === "text")) write("\n");

      await deps.transcript.append({
        type: "message",
        message: { role: "assistant", content: message.content },
      });
      if (message.stop !== "tool_use") {
        if (await readInbox()) continue;
        return;
      }

      const results: ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        write(`\x1b[2m▸ ${block.name} ${JSON.stringify(block.input).slice(0, 100)}\x1b[0m\n`, true);
        const result = await runTool(block.name, block.input as Record<string, unknown>);
        results.push({ ...result, tool_use_id: block.id });
      }
      // Queued messages ride along after the tool results; they never cut a tool short.
      const note = await inboxBlock();
      await deps.transcript.append({ type: "message", message: { role: "user", content: note ? [...results, note] : results } });
    }
  }

  return { run };
}


export async function runAgent(opts: AgentOptions): Promise<void> {
  const config = await loadConfig();
  // One transcript per role per branch, so a restart resumes it. spawn seeds
  // it with the prompt before starting this process.
  const transcript = open(paths.transcript(opts.project, sessionId(opts.role, opts.branch)));
  if (transcript.head() === null) {
    if (opts.branch) throw new Error(`agent: no transcript for ${sessionId(opts.role, opts.branch)}; spawn seeds it`);
    await transcript.append({ type: "meta", role: opts.role, model: config.model });
  }

  const tools: Record<string, Tool> = {};
  for (const name of toolsFor[opts.role]) {
    const tool = registry[name];
    if (tool) tools[name] = tool;
  }

  const agent = createAgent({
    provider: await providerFromAccounts(providerFor(config.model)),
    transcript,
    tools,
    model: config.model,
    system: rolePrompt(opts.role, config),
    ctx: { project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
  });
  await agent.run();
}
