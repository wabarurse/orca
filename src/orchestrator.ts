// The orchestrator runs in the `start` process, not in tmux. One turn is:
// drain its inbox, hand the messages to the model as one user message, run
// the loop until it stops calling tools, then drain the user's inbox for
// anything addressed to them.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync } from "node:fs";
import { createAgent, type AgentClient } from "./agent";
import { loadConfig, paths } from "./config";
import { drain, pending, put, type Message } from "./inbox";
import { registry, toolsFor, type Tool } from "./tools/index";
import { open, type Transcript } from "./transcript";

export interface OrchestratorDeps {
  project: string;
  client?: AgentClient;
  tools?: Record<string, Tool>;
  transcript?: Transcript;
  write?: (text: string) => void;
}

export interface Orchestrator {
  /** Put a message from the user in the orchestrator's inbox. */
  say(text: string): Promise<void>;
  /** True when the orchestrator has unread messages. */
  pending(): Promise<boolean>;
  /** Run one turn over the inbox. Returns what was sent to the user meanwhile. */
  turn(): Promise<Message[]>;
}

/** Make sure ~/.parallels/projects/<name>/repo exists, cloning it if a url is given. */
export async function ensureProject(project: string, url?: string): Promise<void> {
  const repo = paths.repo(project);
  mkdirSync(paths.project(project), { recursive: true });
  if (existsSync(repo)) return;
  if (!url) throw new Error(`no repo at ${repo}; pass a git url the first time`);
  const res = await Bun.$`git clone ${url} ${repo}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git clone failed: ${res.stderr.toString().trim()}`);
}

export async function createOrchestrator(deps: OrchestratorDeps): Promise<Orchestrator> {
  const { project } = deps;
  const config = await loadConfig();
  const transcript = deps.transcript ?? open(paths.transcript(project, "orchestrator"));
  if (transcript.head() === null) {
    await transcript.append({ type: "meta", role: "orchestrator", model: config.model });
  }

  const tools: Record<string, Tool> = deps.tools ?? {};
  if (!deps.tools) for (const name of toolsFor.orchestrator) if (registry[name]) tools[name] = registry[name];

  const agent = createAgent({
    client: deps.client ?? new Anthropic(),
    transcript,
    tools,
    model: config.model,
    ctx: { project, role: "orchestrator", cwd: paths.repo(project) },
    write: deps.write,
  });

  return {
    say: (text) => put(project, "orchestrator", { from: "user", text }).then(() => {}),
    pending: () => pending(project, "orchestrator"),
    async turn() {
      // run() drains the inbox itself and keeps going while messages arrive.
      if (!(await pending(project, "orchestrator"))) return [];
      await agent.run();
      return drain(project, "user");
    },
  };
}
