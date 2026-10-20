// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different tool set. There is no system prompt: the model gets its task
// through the first user message (spawn's brief, or the inbox) and the tool
// descriptions, nothing else.
//
// The SDK's Tool Runner drives the request → tool call → result loop. We only
// stream text, print tool calls, and append each turn to the transcript.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { loadConfig, paths } from "./config";
import { sessionId } from "./runner";
import { open, type Role, type Transcript } from "./transcript";
import { registry, toolsFor, type Tool, type ToolContext } from "./tools/index";

export interface AgentOptions {
  project: string;
  role: Role;
  branch?: string;
}

/** The slice of the SDK the loop needs; tests pass a fake. */
export interface AgentRunner {
  [Symbol.asyncIterator](): AsyncIterator<{
    on(event: "text", cb: (delta: string) => void): unknown;
    finalMessage(): Promise<BetaMessage>;
  }>;
  /** The tool results for the last assistant message, or null when it made no calls. */
  generateToolResponse(): Promise<BetaMessageParam | null>;
}

export interface AgentClient {
  beta: { messages: { toolRunner(params: BetaToolRunnerParams & { stream: true }): AgentRunner } };
}

export interface AgentDeps {
  client: AgentClient;
  transcript: Transcript;
  tools: Record<string, Tool>;
  model: string;
  ctx: ToolContext;
  /** Where streamed text goes; defaults to stdout. */
  write?: (text: string) => void;
}

const MAX_TOKENS = 64000;

/** Wrap our tools as SDK runnable tools, with the agent's context closed over. */
export function runnable(tools: Record<string, Tool>, ctx: ToolContext): BetaRunnableTool[] {
  return Object.values(tools).map((tool) => ({
    ...tool.spec,
    parse: (input: unknown) => input as Record<string, unknown>,
    run: (input: Record<string, unknown>) => tool.run(input, ctx),
  })) as BetaRunnableTool[];
}

/** Build the loop from explicit dependencies. `runAgent` wires the real ones. */
export function createAgent(deps: AgentDeps) {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));

  async function run(): Promise<void> {
    const runner = deps.client.beta.messages.toolRunner({
      model: deps.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: (await deps.transcript.chain()) as BetaMessageParam[],
      tools: runnable(deps.tools, deps.ctx),
    });

    for await (const stream of runner) {
      stream.on("text", write);
      const message = await stream.finalMessage();
      if (message.content.some((b) => b.type === "text")) write("\n");
      for (const block of message.content) {
        if (block.type === "tool_use") write(`\x1b[2m▸ ${block.name} ${JSON.stringify(block.input).slice(0, 100)}\x1b[0m\n`);
      }
      await deps.transcript.append({
        type: "message",
        message: { role: "assistant", content: message.content } as MessageParam,
      });
      // Runs the tools now (the runner caches the result so it won't run them twice).
      const results = await runner.generateToolResponse();
      if (results) await deps.transcript.append({ type: "message", message: results as MessageParam });
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
    client: new Anthropic(),
    transcript,
    tools,
    model: config.model,
    ctx: { project: opts.project, role: opts.role, branch: opts.branch, cwd: process.cwd() },
  });
  await agent.run();
}
