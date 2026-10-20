// The orchestrator runs in the `start` process, not in tmux. One turn is:
// drain the inbox, hand the messages to the model as one user message, run
// the loop until it stops calling tools, then drain the outbox for replies.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createAgent, loadPrompt, type AgentClient } from "./agent";
import { loadConfig, paths } from "./config";
import { drain, put, type Message } from "./inbox";
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
  /** Queue a message from the user. */
  say(text: string): Promise<void>;
  /** True when something is waiting in the inbox. */
  pending(): Promise<boolean>;
  /** Run one turn over everything in the inbox. Returns the outbox replies. */
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

export function formatInbox(msgs: Message[]): string {
  return msgs.map((m) => `[${m.from}] ${m.text}`).join("\n\n");
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
    system: await loadPrompt("orchestrator"),
    ctx: { project, role: "orchestrator", cwd: paths.repo(project) },
    write: deps.write,
  });

  return {
    async say(text) {
      await put(project, { from: "user", text });
    },
    async pending() {
      if (!existsSync(paths.inbox(project))) return false;
      return (await readdir(paths.inbox(project))).some((n) => n.endsWith(".json"));
    },
    async turn() {
      const msgs = await drain(project);
      if (msgs.length === 0) return [];
      await transcript.append({ type: "message", message: { role: "user", content: formatInbox(msgs) } });
      await agent.run();
      return drain(project, "outbox");
    },
  };
}
