// The orchestrator runs in the `start` process, not in tmux. One turn is:
// drain its inbox, hand the messages to the model as one user message, run
// the loop until it stops calling tools, then drain the user's inbox for
// anything addressed to them.

import { existsSync, mkdirSync } from "node:fs";
import { provider as providerFromAccounts } from "./accounts";
import { createAgent } from "./agent";
import { loadConfig, paths } from "./config";
import { drain, pending, put, type Message } from "./inbox";
import { rolePrompt } from "./prompts";
import { providerFor, type Provider } from "./providers/index";
import { registry, toolsFor, type Tool } from "./tools/index";
import { open, type Entry, type Transcript } from "./transcript";

export interface OrchestratorDeps {
  project: string;
  provider?: Provider;
  tools?: Record<string, Tool>;
  transcript?: Transcript;
  /** Streamed model text; `plain` marks tool lines, which are not markdown. */
  write?: (text: string, plain?: boolean) => void;
  /** Each batch of inbox messages (the user's and agents') as the orchestrator reads it. */
  onInbox?: (msgs: Message[]) => void;
}

export interface Orchestrator {
  /** Put a message from the user in the orchestrator's inbox. */
  say(text: string): Promise<void>;
  /** True when the orchestrator has unread messages. */
  pending(): Promise<boolean>;
  /** Run one turn over the inbox. Returns what was sent to the user meanwhile. */
  turn(): Promise<Message[]>;
  /** The current branch of its transcript, oldest first, as loaded (transcript.ts `branch`): what the TUI rebuilds the page from. */
  entries?(): Entry[];
}

/**
 * Make sure ~/.parallels/projects/<name>/repo exists: clone it when a url is
 * given, otherwise start an empty repository the orchestrator can fill.
 */
export async function ensureProject(project: string, url?: string): Promise<void> {
  const repo = paths.repo(project);
  mkdirSync(paths.project(project), { recursive: true });
  if (existsSync(repo)) return;
  const res = url ? await Bun.$`git clone ${url} ${repo}`.quiet().nothrow() : await Bun.$`git init -q ${repo}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git ${url ? "clone" : "init"} failed: ${res.stderr.toString().trim()}`);
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

  return {
    say: (text) => put(project, "orchestrator", { from: "user", text }).then(() => {}),
    pending: () => pending(project, "orchestrator"),
    entries: () => transcript.branch(),
    async turn() {
      // run() drains the inbox itself and keeps going while messages arrive.
      if (!(await pending(project, "orchestrator"))) return [];
      // Config is re-read every turn so /models and /review-rounds take effect on the next turn.
      const config = await loadConfig();
      const { model } = config;
      const agent = createAgent({
        provider: deps.provider ?? (await providerFromAccounts(providerFor(model))),
        transcript,
        tools,
        model,
        system: rolePrompt("orchestrator", config),
        ctx: { project, role: "orchestrator", cwd: paths.repo(project) },
        write: deps.write,
        onInbox: deps.onInbox,
      });
      await agent.run();
      const replies = await drain(project, "user");
      // Kept in the transcript so a restored page shows them where they showed live: after the turn.
      if (replies.length) await transcript.append({ type: "replies", messages: replies.map(({ from, text }) => ({ from, text })) });
      return replies;
    },
  };
}

