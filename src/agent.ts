// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set. There is no system prompt: the model gets its task
// through the first user message (spawn's brief, or the inbox) and the tool
// descriptions, nothing else.

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { provider as providerFromAccounts } from "./accounts";
import { loadConfig, paths } from "./config";
import { drain, format } from "./inbox";
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
  ctx: ToolContext;
  /** Where streamed text goes; defaults to stdout. */
  write?: (text: string) => void;
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

  /** Move waiting inbox messages into the transcript as one user turn. */
  async function readInbox(): Promise<boolean> {
    const msgs = await drain(deps.ctx.project, me);
    if (msgs.length === 0) return false;
    await deps.transcript.append({ type: "message", message: { role: "user", content: format(msgs) } });
    return true;
  }

  /**
   * Run until the model ends a turn with an empty inbox. Messages that arrive
   * while it works are read at the end of each turn, so a worker that gets a
   * note from the orchestrator keeps going instead of exiting.
   */
  async function run(): Promise<void> {
    await readInbox();
    for (;;) {
      const message = await deps.provider.complete({
        model: deps.model,
        maxTokens: MAX_TOKENS,
        messages: await deps.transcript.chain(),
        tools,
        onText: write,
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
        write(`\x1b[2m▸ ${block.name} ${JSON.stringify(block.input).slice(0, 100)}\x1b[0m\n`);
        const result = await runTool(block.name, block.input as Record<string, unknown>);
        results.push({ ...result, tool_use_id: block.id });
      }
      await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
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
    ctx: { project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
  });
  await agent.run();
}
