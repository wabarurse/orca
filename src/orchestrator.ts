import { inputEpoch, advanceInputEpoch } from "./user-input";
import { Cancelled } from "./cancellation";
import { projectIdentity, withProjectStateLock } from "./project-state";
// The orchestrator runs in the `start` process, not in tmux. One turn is:
// drain its inbox, hand the messages to the model as one user message, run
// the loop until it stops calling tools, then drain the user's inbox for
// anything addressed to them.

import { existsSync, mkdirSync } from "node:fs";
import { effectiveModel, projectModelResolver } from "./project-model";
import { createAgent, type AgentDeps } from "./agent";
import { loadConfig, paths } from "./config";
import { drain, pending, pendingInput, put, userInEpoch, type Message } from "./inbox";
import { rolePrompt } from "./prompts";
import { type Provider } from "./providers/index";
import { registry, toolsFor, type Tool } from "./tools/index";
import { open, type Entry, type Transcript } from "./transcript";

export interface OrchestratorDeps {
  project: string;
  /** Injectable persistence boundary; submission identity is captured before this call. */
  put?: typeof put;
  provider?: Provider;
  loadProvider?: Parameters<typeof projectModelResolver>[1];
  tools?: Record<string, Tool>;
  transcript?: Transcript;
  /** Streamed model text; `plain` marks tool lines, which are not markdown. */
  write?: (text: string, plain?: boolean) => void;
  /** Each batch of inbox messages (the user's and agents') as the orchestrator reads it. */
  onInbox?: (msgs: Message[]) => void;
  /** Each tool call as it starts and ends (the TUI shows it running, then its line and summary). */
  onTool?: AgentDeps["onTool"];
  onToolResult?: AgentDeps["onToolResult"];
}

export interface Orchestrator {
  /** Put a user message in the inbox; optional inputId round-trips unchanged through onInbox for UI ownership. */
  say(text: string, submission?: string, inputId?: string): Promise<void>;
  /** Capture before holding input for login (or any other asynchronous UI operation). */
  submission?(): string;
  /** Abort only this turn and pause automatic inbox turns until the user sends again. */
  cancel?(): void;
  compact?(): Promise<void>;
  /** Refuse unless this session is idle and its raw durable inbox is empty (even paused input). */
  checkClear?(): Promise<void>;
  /** Locally confirmed reset; no provider calls, input draining, retries or restarts. */
  clear?(signal?: AbortSignal): Promise<void>;
  /** True when the orchestrator has unread messages. */
  pending(): Promise<boolean>;
  /** Run one turn over the inbox. Returns what was sent to the user meanwhile. */
  turn(): Promise<Message[]>;
  /** Full original history, oldest first, excluding synthetic checkpoint tails: UI replay. */
  entries?(): Entry[];
}

/**
 * Make sure ~/.parallels/projects/<name>/repo exists: clone it when a url is
 * given, otherwise start an empty repository the orchestrator can fill.
 */
export function ensureProject(project: string, url?: string): Promise<void> {
  return withProjectStateLock(project, () => initializeProject(project, url));
}
async function initializeProject(project: string, url?: string): Promise<void> {
  const repo = paths.repo(project);
  mkdirSync(paths.project(project), { recursive: true });
  if (existsSync(repo)) return;
  const res = url ? await Bun.$`git clone ${url} ${repo}`.quiet().nothrow() : await Bun.$`git init -q ${repo}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`git ${url ? "clone" : "init"} failed: ${res.stderr.toString().trim()}`);
}

export async function createOrchestrator(deps: OrchestratorDeps): Promise<Orchestrator> {
  const { project } = deps;
  const transcript = deps.transcript ?? open(paths.transcript(project, "orchestrator"));
  if (transcript.head() === null) {
    await transcript.append({ type: "meta", role: "orchestrator", model: await effectiveModel(project) });
  }

  return orchestratorSession(deps, transcript);
}

/** A small lifecycle owner keeps submission, pause and active-request state separate. */
class TurnControl {
  private paused: string | undefined;
  cancellation?: AbortController;
  requested = false;
  running = false;
  clearing?: AbortController;
  submitting = 0;
  constructor(private project: string) {}
  cancel(): void {
    this.paused = advanceInputEpoch(this.project);
    this.requested = false;
    this.cancellation?.abort(new Cancelled());
    this.clearing?.abort(new Cancelled());
  }
  async isPaused(): Promise<boolean> {
    const epoch = this.paused;
    if (epoch === undefined) return false;
    const fresh = await userInEpoch(this.project, "orchestrator", epoch);
    if (fresh && this.paused === epoch) this.paused = undefined;
    return this.paused !== undefined;
  }
  compact(): void {
    if (this.clearing) throw new Error("context clear in progress");
    this.paused = undefined; this.requested = true;
  }
  takeRequest = (): boolean => { const value = this.requested; this.requested = false; return value; };
}
function orchestratorSession(deps: OrchestratorDeps, transcript: Transcript): Orchestrator {
  const state = new TurnControl(deps.project);
  // A Page/session cannot acquire ownership of a deleted/recreated project.
  const identity = existsSync(paths.project(deps.project)) ? projectIdentity(deps.project) : undefined;
  const check = async () => {
    if (!identity || projectIdentity(deps.project) !== identity) throw new Error("project changed; reopen it before clearing context");
    if (state.running || state.requested) throw new Error("orchestrator is running or compacting; wait before clearing context");
    if (state.submitting || await pendingInput(deps.project, "orchestrator")) throw new Error("input is pending; context was not cleared");
  };
  return {
    checkClear: async () => {
      if (state.clearing) throw new Error("context clear in progress");
      await check();
    },
    clear: async signal => {
      if (state.clearing) throw new Error("context clear in progress");
      if (state.running || state.requested) throw new Error("orchestrator is running or compacting; wait before clearing context");
      if (state.submitting) throw new Error("input is pending; context was not cleared");
      const clearing = state.clearing = new AbortController();
      const authorization = signal ? AbortSignal.any([signal, clearing.signal]) : clearing.signal;
      try {
        await withProjectStateLock(deps.project, async () => {
          authorization.throwIfAborted();
          await check();
          await transcript.append({ type: "context-boundary" }, authorization);
        });
      } finally { state.clearing = undefined; }
    },
    cancel: () => state.cancel(),
    compact: async () => state.compact(),
    submission: () => inputEpoch(deps.project),
    say: async (text, submission = inputEpoch(deps.project), inputId) => {
      state.submitting++;
      state.clearing?.abort(new Error("input arrived; context was not cleared"));
      try { await (deps.put ?? put)(deps.project, "orchestrator", { from: "user", text, userEpoch: submission, ...(inputId ? { inputId } : {}) }); }
      finally { state.submitting--; }
    },
    pending: async () => !(await state.isPaused()) && (state.requested || await pending(deps.project, "orchestrator")),
    entries: () => transcript.history?.() ?? transcript.branch(),
    turn: () => orchestratorTurn(deps, transcript, state),
  };
}
async function orchestratorTurn(deps: OrchestratorDeps, transcript: Transcript, state: TurnControl): Promise<Message[]> {
  if (state.running || state.clearing) return [];
  state.running = true;
  const cancellation = state.cancellation = new AbortController();
  try {
    if (await state.isPaused()) return [];
    const hasInbox = await pending(deps.project, "orchestrator");
    if (!state.requested && !hasInbox) return [];
    const agent = await turnAgent(deps, transcript, state.takeRequest, cancellation.signal);
    if (hasInbox) await agent.run();
    else if (state.takeRequest()) await agent.compact();
    return await replies(deps.project, transcript);
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
    return [];
  } finally { state.running = false; state.cancellation = undefined; }
}
async function replies(project: string, transcript: Transcript): Promise<Message[]> {
  const messages = await drain(project, "user");
  if (messages.length) await transcript.append({ type: "replies", messages: messages.map(({ from, text }) => ({ from, text })) });
  return messages;
}

function orchestratorTools(overrides?: Record<string, Tool>): Record<string, Tool> {
  if (overrides) return overrides;
  return Object.fromEntries(toolsFor.orchestrator.flatMap(name => registry[name] ? [[name, registry[name]]] : []));
}
async function turnAgent(deps: OrchestratorDeps, transcript: Transcript, compactRequested: () => boolean, signal: AbortSignal) {
  const config = await loadConfig();
  const loadProvider = deps.loadProvider ?? (deps.provider ? async () => deps.provider! : undefined);
  return createAgent({
    signal,
    toolConcurrency: config.toolConcurrency,
    resolveModel: projectModelResolver(deps.project, loadProvider),
    transcript, tools: orchestratorTools(deps.tools), model: await effectiveModel(deps.project),
    compaction: { enabled: config.compact, fallback: config.contextLimitFallback }, compactRequested,
    system: rolePrompt("orchestrator", config),
    ctx: { project: deps.project, role: "orchestrator", cwd: paths.repo(deps.project) },
    write: deps.write, onInbox: deps.onInbox,
    onTool: deps.onTool, onToolResult: deps.onToolResult,
  });
}
