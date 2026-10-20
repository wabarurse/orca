// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different role, system prompt and tool set.

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsStreaming,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { join } from "node:path";
import { loadConfig, paths } from "./config";
import { readTasks } from "./tasks";
import { open, type Role, type Transcript } from "./transcript";
import { registry, toolsFor, type Tool, type ToolContext } from "./tools/index";

export interface AgentOptions {
  project: string;
  role: Role;
  taskId?: string;
  /** Transcript id; a new one is created when omitted. */
  session?: string;
}

/** The slice of the SDK client the loop needs; tests pass a fake. */
export interface AgentClient {
  messages: {
    stream(params: MessageCreateParamsStreaming): {
      on(event: "text", cb: (delta: string) => void): unknown;
      finalMessage(): Promise<Message>;
    };
  };
}

export interface AgentDeps {
  client: AgentClient;
  transcript: Transcript;
  tools: Record<string, Tool>;
  model: string;
  system: string;
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

  async function run(): Promise<void> {
    for (;;) {
      const stream = deps.client.messages.stream({
        model: deps.model,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: deps.system,
        messages: await deps.transcript.chain(),
        ...(tools.length ? { tools } : {}),
      });
      stream.on("text", write);
      const message = await stream.finalMessage();
      if (message.content.some((b) => b.type === "text")) write("\n");

      await deps.transcript.append({
        type: "message",
        message: { role: "assistant", content: message.content },
      });
      if (message.stop_reason !== "tool_use") return;

      const results: ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        const result = await runTool(block.name, block.input as Record<string, unknown>);
        results.push({ ...result, tool_use_id: block.id });
      }
      await deps.transcript.append({ type: "message", message: { role: "user", content: results } });
    }
  }

  return { run };
}

export async function loadPrompt(role: Role): Promise<string> {
  const user = Bun.file(join(paths.prompts, `${role}.md`));
  if (await user.exists()) return user.text();
  return Bun.file(join(import.meta.dir, "..", "prompts", `${role}.md`)).text();
}

/** The first user message a worker or reviewer sees: its task, from tasks.json. */
export async function taskBrief(project: string, role: Role, taskId: string): Promise<string> {
  const task = (await readTasks(project)).find((t) => t.id === taskId);
  if (!task) throw new Error(`agent: no task ${taskId} in ${project}`);
  const verb = role === "reviewer" ? "Review" : "Implement";
  return `${verb} task ${task.id} on branch \`${task.branch}\`.\n\n${task.desc}`;
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  const config = await loadConfig();
  // Workers and reviewers get one transcript per task so a restart resumes it.
  const session = opts.session ?? (opts.taskId ? `${opts.role}-${opts.taskId}` : opts.role);
  const transcript = open(paths.transcript(opts.project, session));
  if (transcript.head() === null) {
    await transcript.append({ type: "meta", role: opts.role, taskId: opts.taskId, model: config.model });
    if (opts.taskId) {
      const brief = await taskBrief(opts.project, opts.role, opts.taskId);
      await transcript.append({ type: "message", message: { role: "user", content: brief } });
    }
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
    system: await loadPrompt(opts.role),
    ctx: { project: opts.project, role: opts.role, taskId: opts.taskId, cwd: process.cwd() },
  });
  await agent.run();
}
