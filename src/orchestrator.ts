import { budget } from "./compaction";
import { contextMessages } from "./transcript";
import { pendingImageInputs, type ImageRef } from "./images";
import { tryStorageLock } from "./storage-lock";
import { inputEpoch, advanceInputEpoch } from "./user-input";
import { Cancelled } from "./cancellation";
import { projectIdentity, projectTurnLock as turnLock, withProjectStateLock } from "./project-state";
// The orchestrator runs in the `start` process, not in tmux. One turn is:
// drain its inbox, hand the messages to the model as one user message, run
// the loop until it stops calling tools, then drain the user's inbox for
// anything addressed to them.

import { existsSync } from "node:fs";
import { assertMainCheckout, initializeWorkspace } from "./workspace";
import { effectiveModel, projectModelResolver } from "./project-model";
import { createAgent, type AgentDeps } from "./agent";
import { loadConfig, paths } from "./config";
import { consume, pending, pendingInput, put, userInEpoch, type Message } from "./inbox";
import { rolePrompt } from "./prompts";
import { type Provider } from "./providers/index";
import { registry, toolsFor, type Tool } from "./tools/index";
import { open, type Entry, type Transcript } from "./transcript";
import { RollingCompactor, type RollingOptions } from "./rolling-memory";
import { orchestratorTask } from "./tools/task";

export interface OrchestratorDeps {
  project: string;
  /** One-shot CLI cancellation and joining use the same whole-turn owner as TUI. */
  signal?: AbortSignal;
  joinRolling?: boolean;
  /** Injectable persistence boundary; submission identity is captured before this call. */
  put?: typeof put;
  provider?: Provider;
  loadProvider?: Parameters<typeof projectModelResolver>[1];
  tools?: Record<string, Tool>;
  transcript?: Transcript;
  /** Separate summary connection; production uses the configured OpenAI account. */
  rolling?: RollingOptions;
  /** Streamed model text; `plain` marks tool lines, which are not markdown. */
  write?: (text: string, plain?: boolean) => void;
  /** Each batch of inbox messages (the user's and agents') as the orchestrator reads it. */
  onInbox?: (msgs: Message[]) => void;
  /** Each tool call as it starts and ends (the TUI shows it running, then its line and summary). */
  onTool?: AgentDeps["onTool"];
  onToolResult?: AgentDeps["onToolResult"];
  /** Safe boundary snapshot before a turn starts streaming; presentation only. */
  onRefresh?: () => void;
}

export interface Orchestrator {
  /** Conservative current-context estimate, never cumulative billing usage. */
  contextUsage?(model: string): number | undefined;
  /** Put a user message in the inbox; optional inputId round-trips unchanged through onInbox for UI ownership. */
  say(text: string, submission?: string, inputId?: string, attachments?: ImageRef[]): Promise<void>;
  /** Capture before holding input for login (or any other asynchronous UI operation). */
  submission?(): string;
  /** Abort only this turn and pause automatic inbox turns until the user sends again. */
  cancel?(): void;
  /** Release the background summarizer when its page closes. */
  dispose?(): void;
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
  /** Read-only shared snapshot; false means active context reload must wait. */
  refresh?(): Promise<boolean>;
  consumed?(): Set<string>;
}

/** Bind a new project to its original checkout, or reopen an existing project. */
export function ensureProject(project: string, directory?: string): Promise<void> {
  return withProjectStateLock(project, () => initializeWorkspace(project, directory));
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
  private compactEpoch?: string;
  cancellation?: AbortController;
  requested = false;
  running = false;
  clearing?: AbortController;
  submitting = 0;
  refreshing?: Promise<void>;
  context?: AgentDeps;
  constructor(private project: string, private transcript: Transcript) {}
  pause(): void {
    advanceInputEpoch(this.project);
    this.compactEpoch = undefined;
    this.requested = false;
  }
  cancel(): void {
    this.pause();
    this.cancellation?.abort(new Cancelled());
    this.clearing?.abort(new Cancelled());
  }
  async isPaused(): Promise<boolean> {
    const epoch = inputEpoch(this.project);
    if (this.compactEpoch !== undefined && this.compactEpoch !== epoch) {
      this.compactEpoch = undefined; this.requested = false;
    }
    if (!epoch || this.compactEpoch === epoch || this.transcript.consumed?.().epochs.has(epoch)) return false;
    // Cancellation is shared: another window must not process pre-cancel input.
    return !await userInEpoch(this.project, "orchestrator", epoch);
  }
  compact(): void {
    if (this.clearing) throw new Error("context clear in progress");
    // Explicit /compact keeps its existing local resume authorization. A later
    // cancellation in ANY window changes the epoch and invalidates it.
    this.compactEpoch = inputEpoch(this.project);
    this.requested = true;
  }
  takeRequest = (): boolean => { const value = this.requested; this.requested = false; return value; };
}
function orchestratorSession(deps: OrchestratorDeps, transcript: Transcript): Orchestrator {
  const state = new TurnControl(deps.project, transcript);
  const rolling = new RollingCompactor(deps.project, transcript, deps.rolling);
  // A Page/session cannot acquire ownership of a deleted/recreated project.
  const identity = existsSync(paths.project(deps.project)) ? projectIdentity(deps.project) : undefined;
  const checkIdentity = () => {
    if (identity && projectIdentity(deps.project) !== identity) throw new Error("project changed; reopen it before continuing");
  };
  const check = async (ownsTurn = false) => {
    checkIdentity();
    if (state.running || state.requested || (!ownsTurn && existsSync(turnLock(deps.project)))) throw new Error("orchestrator is running or compacting; wait before clearing context");
    if ((await pendingImageInputs(deps.project, transcript.consumed?.().inputs)).length) throw new Error("image input is pending; retry it before clearing context");
    if (state.submitting || await pendingInput(deps.project, "orchestrator")) throw new Error("input is pending; context was not cleared");
  };
  const refresh = async () => {
    if (state.running || state.clearing) return false;
    checkIdentity();
    const request = state.refreshing ??= Promise.resolve().then(() => transcript.refresh?.());
    try { await request; rolling.reconcile(); return !state.running && !state.clearing; }
    finally { if (state.refreshing === request) state.refreshing = undefined; }
  };
  let cachedContext: AgentDeps | undefined;
  let cachedHead: string | null | undefined, cachedModel: string | undefined, cachedUsed: number | undefined;
  return {
    contextUsage: (model) => {
      if (!state.context || state.context.model !== model) return undefined;
      const head = transcript.head();
      if (head !== cachedHead || model !== cachedModel || cachedContext !== state.context) {
        cachedContext = state.context;
        cachedHead = head; cachedModel = model;
        cachedUsed = budget({ ...state.context, compaction: undefined }, contextMessages(transcript.branch()));
      }
      return cachedUsed;
    },
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
      let release: (() => Promise<void>) | undefined;
      try {
        release = await tryStorageLock(turnLock(deps.project));
        if (!release) throw new Error("orchestrator is running in another session; wait before clearing context");
        await state.refreshing;
        await withProjectStateLock(deps.project, async () => {
          authorization.throwIfAborted();
          await check(true);
          rolling.reset();
          await transcript.append({ type: "context-boundary" }, authorization);
        });
      } finally { state.clearing = undefined; await release?.(); }
    },
    cancel: () => { rolling.reset(); state.cancel(); },
    dispose: () => rolling.dispose(),
    compact: async () => state.compact(),
    submission: () => inputEpoch(deps.project),
    say: async (text, submission = inputEpoch(deps.project), inputId, attachments) => {
      checkIdentity();
      state.submitting++;
      state.clearing?.abort(new Error("input arrived; context was not cleared"));
      try { await (deps.put ?? put)(deps.project, "orchestrator", { from: "user", text, ...(attachments?.length ? { attachments } : {}), userEpoch: submission, ...(inputId ? { inputId } : {}) }); }
      finally { state.submitting--; }
    },
    pending: async () => !existsSync(turnLock(deps.project)) && await refresh() &&
      !(await state.isPaused()) && (state.requested || rolling.ready() || await pending(deps.project, "orchestrator")),
    entries: () => transcript.history?.() ?? transcript.branch(),
    consumed: () => transcript.consumed?.().inputs ?? new Set(),
    refresh,
    turn: () => orchestratorTurn(deps, transcript, state, checkIdentity, rolling),
  };
}
async function orchestratorTurn(deps: OrchestratorDeps, transcript: Transcript, state: TurnControl, checkIdentity: () => void, rolling: RollingCompactor): Promise<Message[]> {
  if (state.running || state.clearing) return [];
  state.running = true;
  const cancellation = state.cancellation = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, cancellation.signal]) : cancellation.signal;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await tryStorageLock(turnLock(deps.project));
    if (!release) return [];
    signal.throwIfAborted();
    checkIdentity();
    await state.refreshing;
    await transcript.refresh?.();
    rolling.reconcile();
    deps.onRefresh?.();
    if (await state.isPaused()) return [];
    const hasInbox = await pending(deps.project, "orchestrator");
    if (!state.requested && !hasInbox && !rolling.ready()) return [];
    try { await assertMainCheckout(deps.project); }
    catch (error) { state.pause(); throw error; } // Retain input without a failing poll/retry loop.
    const agent = await turnAgent(deps, transcript, state.takeRequest, signal, rolling, current => { state.context = current; });
    if (hasInbox) await agent.run();
    else if (state.takeRequest()) await agent.compact();
    else await agent.maintain();
    if (deps.joinRolling && await rolling.finish(signal)) await agent.maintain();
    return await replies(deps.project, transcript);
  } catch (error) {
    if (!signal.aborted) throw error;
    return [];
  } finally { await release?.(); state.running = false; state.cancellation = undefined; }
}
async function replies(project: string, transcript: Transcript): Promise<Message[]> {
  return consume(project, "user", transcript, inbox => transcript.append({ type: "replies", inbox,
    messages: inbox.map(({ from, text }) => ({ from, text })) }));
}

function orchestratorTools(overrides?: Record<string, Tool>): Record<string, Tool> {
  if (overrides) return overrides;
  return Object.fromEntries(toolsFor.orchestrator.flatMap(name => registry[name] ? [[name, name === "task" ? orchestratorTask : registry[name]]] : []));
}
async function turnAgent(deps: OrchestratorDeps, transcript: Transcript, compactRequested: () => boolean, signal: AbortSignal, rolling: RollingCompactor, onContext: (current: AgentDeps) => void) {
  const epoch = inputEpoch(deps.project);
  const config = await loadConfig();
  const loadProvider = deps.loadProvider ?? (deps.provider ? async () => deps.provider! : undefined);
  return createAgent({
    signal, requireInbox: true, onContext,
    toolConcurrency: config.toolConcurrency,
    resolveModel: projectModelResolver(deps.project, loadProvider),
    transcript, tools: orchestratorTools(deps.tools), model: await effectiveModel(deps.project),
    compaction: { enabled: config.compact, fallback: config.contextLimitFallback }, compactRequested,
    compactBoundary: async (current, manual, maintenance) => {
      if (inputEpoch(deps.project) !== epoch) { rolling.reset(); return; }
      await rolling.boundary(current, manual, maintenance);
    },
    system: rolePrompt("orchestrator", config),
    ctx: { project: deps.project, role: "orchestrator", cwd: paths.repo(deps.project) },
    write: deps.write, onInbox: deps.onInbox,
    onTool: deps.onTool, onToolResult: deps.onToolResult,
  });
}
