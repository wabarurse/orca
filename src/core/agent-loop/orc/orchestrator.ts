import { budget, type CompactOptions } from "../../data/memory/compaction";
import { contextWindow, type ContextWindow } from "../../../providers/catalog/context-window";
import { contextMessages } from "../../data/transcripts/transcript";
import { pendingImageInputs, type ImageRef } from "../../data/images/images";
import { tryStorageLock } from "../../data/storage-lock";
import { inputEpoch, advanceInputEpoch } from "../../data/inbox/user-input";
import { Cancelled } from "../../tmux/cancellation";
import { projectIdentity, turnLocks, turnLocksHeld, withProjectStateLock } from "../../data/projects/state";
// The orchestrator session: one turn is: drain its inbox, hand the messages to
// the model as one user message, run the loop until it stops calling tools,
// then drain the user's inbox for anything addressed to them. In production
// the daemon (src/core/agent-loop/orc/daemon.ts) owns the session in the project's
// tmux session; the TUI is a client of its files (src/core/agent-loop/orc/client.ts).

import { existsSync } from "node:fs";
import { assertMainCheckout, initializeWorkspace } from "../../data/projects/workspace";
import { effectiveModel, projectModelResolver } from "../../data/projects/project-model";
import { createAgent, type AgentDeps } from "../loop/agent";
import type { Tracker } from "../../tmux/exits";
import { loadConfig, paths, type Config } from "../../../config/config";
import { consume, pending, pendingInput, put, userInEpoch, type Message } from "../../data/inbox/inbox";
import { rolePrompt } from "../../prompt/prompts";
import { effectiveFlow } from "../../data/projects/flow";
import { type Provider } from "../../../providers/index";
import { registry, toolsFor, type Tool } from "../../tools/index";
import { open, type Entry, type Transcript } from "../../data/transcripts/transcript";
import { RollingCompactor, type RollingOptions } from "../../data/memory/rolling-memory";
import { orchestratorTask } from "../../tools/task";
import { archiveBestEffort } from "../../data/memory/archive";
import { startMemoryBackfill } from "../../data/memory/backfill";

export interface OrchestratorDeps {
  project: string;
  /** Process-level cancellation, joined with each turn's own; the daemon cancels per turn instead. */
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
  /** The daemon's run record (src/core/tmux/exits.ts), so a crash notice names its last step. */
  tracker?: Tracker;
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
  /** The limit compaction uses for this model with the session's options (estimated when unverified). */
  contextWindow?(model: string): ContextWindow;
  /** Put a user message in the inbox; optional inputId round-trips unchanged through onInbox for UI ownership. */
  say(text: string, submission?: string, inputId?: string, attachments?: ImageRef[]): Promise<void>;
  /** Capture before holding input for login (or any other asynchronous UI operation). */
  submission?(): string;
  /** Abort only this turn and pause automatic inbox turns until the user sends again. */
  cancel?(): void;
  /** Release the background summarizer when its page closes. */
  dispose?(): void;
  compact?(): Promise<void>;
  /** After a saved model change: the daemon confirms which model its next request uses (clients only). */
  observeModel?(model: string): Promise<string>;
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

  // Background and best-effort: the first start after an upgrade migrates old per-project indexes.
  // Disposing the session stops it (it holds project locks while it works).
  const backfill = new AbortController();
  void startMemoryBackfill({ log: memoryLog(deps), signal: backfill.signal });
  let session: Orchestrator;
  try { session = orchestratorSession(deps, transcript, compactionOptions(await loadConfig())); }
  catch (error) { backfill.abort(); throw error; }
  const dispose = session.dispose;
  session.dispose = () => { backfill.abort(); dispose?.(); };
  return session;
}
/** Memory-index problems are reported where the session reports status, never thrown into a turn. */
function memoryLog(deps: OrchestratorDeps): (message: string) => void {
  return message => { if (deps.write) deps.write(`${message}\n`, true); else console.error(message); };
}
/** The options every orchestrator turn compacts with; the header reads them before the first turn. */
function compactionOptions(config: Config): CompactOptions {
  return { enabled: config.compact, fallback: config.contextLimitFallback };
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
function orchestratorSession(deps: OrchestratorDeps, transcript: Transcript, configured: CompactOptions): Orchestrator {
  const state = new TurnControl(deps.project, transcript);
  const rolling = new RollingCompactor(deps.project, transcript, deps.rolling);
  // A Page/session cannot acquire ownership of a deleted/recreated project.
  const identity = existsSync(paths.project(deps.project)) ? projectIdentity(deps.project) : undefined;
  const checkIdentity = () => {
    if (identity && projectIdentity(deps.project) !== identity) throw new Error("project changed; reopen it before continuing");
  };
  const check = async (ownsTurn = false) => {
    checkIdentity();
    if (state.running || state.requested || (!ownsTurn && await turnLocksHeld(deps.project))) throw new Error("orchestrator is running or compacting; wait before clearing context");
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
    contextWindow: model => contextWindow(state.context?.compaction ?? configured, model),
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
        release = await ownTurn(deps.project);
        if (!release) throw new Error("orchestrator is running in another session; wait before clearing context");
        await state.refreshing;
        await withProjectStateLock(deps.project, async () => {
          authorization.throwIfAborted();
          await check(true);
          rolling.reset();
          await archiveBestEffort(deps.project, transcript, memoryLog(deps), true);
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
    // A lock left by a dead owner (a daemon killed mid-turn) does not count: ownTurn moves it aside.
    pending: async () => !await turnLocksHeld(deps.project) && await refresh() &&
      !(await state.isPaused()) && (state.requested || rolling.ready() || await pending(deps.project, "orchestrator")),
    entries: () => transcript.history?.() ?? transcript.branch(),
    consumed: () => transcript.consumed?.().inputs ?? new Set(),
    refresh,
    turn: () => orchestratorTurn(deps, transcript, state, checkIdentity, rolling),
  };
}
/** Own the checkout's turn, then this conversation's; on a partial win nothing stays held. */
async function ownTurn(project: string): Promise<(() => Promise<void>) | undefined> {
  const releases: (() => Promise<void>)[] = [];
  const release = async () => { for (const r of [...releases].reverse()) await r(); };
  for (const path of turnLocks(project)) {
    const r = await tryStorageLock(path, project).catch(async error => { await release(); throw error; });
    if (!r) { await release(); return; }
    releases.push(r);
  }
  return release;
}
async function orchestratorTurn(deps: OrchestratorDeps, transcript: Transcript, state: TurnControl, checkIdentity: () => void, rolling: RollingCompactor): Promise<Message[]> {
  if (state.running || state.clearing) return [];
  state.running = true;
  const cancellation = state.cancellation = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, cancellation.signal]) : cancellation.signal;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await ownTurn(deps.project);
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
    const sent = await replies(deps.project, transcript);
    await archiveBestEffort(deps.project, transcript, memoryLog(deps));
    return sent;
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
    compaction: compactionOptions(config), compactRequested,
    compactBoundary: async (current, manual, maintenance) => {
      if (inputEpoch(deps.project) !== epoch) { rolling.reset(); return; }
      await rolling.boundary(current, manual, maintenance);
    },
    system: rolePrompt("orchestrator", { ...config, ...await effectiveFlow(deps.project, config) }), // per turn, so /review-rounds and /dynamic-dispatch apply next turn
    ctx: { project: deps.project, role: "orchestrator", cwd: paths.repo(deps.project) },
    write: deps.write, onInbox: deps.onInbox, tracker: deps.tracker,
    onTool: deps.onTool, onToolResult: deps.onToolResult,
  });
}
