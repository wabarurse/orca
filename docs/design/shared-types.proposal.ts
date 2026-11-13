// PROPOSAL, not wired in. The contents of a bottom package `src/types/`: data
// shapes used by two or more packages. It imports nothing from the app (only
// SDK types), so config, api, core, tui and cli can all use it.
//
// No optional fields. Every field is always present:
//   unknown or not applicable  → `T | null`
//   none                       → an empty list
//   depends on a state         → a union of shapes, one per state
// Files written by older builds lack some fields, so the reader of each file
// fills them in when it parses. These types describe what the app holds in
// memory after that, never a half-read record.
//
// Tags on each type:
//   SAME     as it is today, from the file named (optionals made explicit)
//   MOVED    same shape, lives below `protocol` today so it is defined elsewhere
//   RENAMED  same shape, clearer name
//   NEW      does not exist today
//   CHANGED  shape differs beyond optionals; the comment says how
//
// Not here on purpose: interfaces with methods (`Provider`, `Tool`), the pure
// formatters and validators that sit beside these types today, and the ~180
// types used inside one package only.

import type { ContentBlock, ImageBlockParam, MessageParam, TextBlockParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";

// ───────────────────────────── identity ─────────────────────────────

/** NEW. A conversation's id, `orch-xxxx`. Today: `project: string` in 396 places. */
export type ProjectId = string;
/** NEW. `orchestrator`, `worker-<branch slug>` or `reviewer-<branch slug>`: an agent's inbox, transcript and window name. */
export type AgentId = string;
/** NEW. One launch of an agent; a respawn on the same branch gets a new one. */
export type RunId = string;
/** NEW. A git branch name as the user or orchestrator wrote it (not the slug). */
export type Branch = string;
/** NEW. A provider's model id, e.g. `claude-opus-5-5`. */
export type ModelId = string;
/** NEW. A task's global UUID (dependencies point at it). `Task.number` is the short project-local one. */
export type TaskId = string;
/** NEW. An ISO-8601 instant, as every stored time is. */
export type Timestamp = string;

/** SAME. protocol/transcript.ts */
export type Role = "orchestrator" | "worker" | "reviewer";

/** NEW. Which agent, in which project, on which launch. Today these fields are repeated in
 * `RunInfo` (core/tmux/exits.ts), `AgentOptions` (agent-loop/loop/agent.ts) and `ToolContext`
 * (core/tools/registry.ts), each with an optional branch. Only the orchestrator has no branch,
 * so that is two shapes, not one optional field. */
export type AgentRef =
  | { project: ProjectId; run: RunId; role: "orchestrator" }
  | { project: ProjectId; run: RunId; role: "worker" | "reviewer"; branch: Branch };

// ───────────────────────────── accounts and models ─────────────────────────────

/** MOVED. api/auth/accounts.ts */
export type ProviderName = "anthropic" | "openai";

/** MOVED. api/auth/accounts.ts. One subscription login; a project selects exactly one. */
export interface AccountRef { provider: ProviderName; profile: string }

/** MOVED. api/auth/accounts.ts. A row in /accounts. */
export interface Account {
  /** "anthropic:<profile>" or "openai:<profile>". */
  id: string;
  provider: ProviderName;
  profile: string;
  ok: boolean;
  active: boolean;
  source: string;
}

/** MOVED. api/model/capabilities.ts */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** MOVED. api/model/settings.ts. What a request carries besides the model. `effort: null` is the provider's default. */
export interface RequestSettings { effort: Effort | null; fast: boolean }

/** MOVED. api/model/context-window.ts. `estimated` when the size is the fallback, not a known one. */
export interface ContextWindow { limit: number; estimated: boolean }

/** CHANGED. Defined twice today as `Partial<Record<Role, string>>` (core/data/projects/project-model.ts,
 * tui/commands/model.ts). Every role is present; null means "uses the project model". */
export type RoleModels = Record<Role, ModelId | null>;

// ───────────────────────────── images ─────────────────────────────

/** MOVED. api/images.ts */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** SAME. protocol/images.ts. A stored image; never the bytes. */
export interface ImageRef { readonly id: string; readonly scope: string; readonly sha256: string }

/** SAME. protocol/images.ts. A prompt as the TUI submits it. */
export interface ImageInput { readonly inputId: string; text: string; submission: string | null; attachments: ImageRef[] }

// ───────────────────────────── inbox ─────────────────────────────

/** NEW name for the inline `event` shape of an inbox message. A runtime observation, never user authority. */
export interface RuntimeEvent { id: string; processId: string | null; topic: string | null; sequence: number; state: string; at: Timestamp }

/** RENAMED from `Message` (protocol/inbox.ts): the SDK also has a `Message`, and both are imported in the same files. */
export interface InboxMessage {
  /** Null for a message a person or agent wrote. */
  event: RuntimeEvent | null;
  /** Identity of a locally submitted prompt, echoed unchanged at consumption; null for anything else. */
  inputId: string | null;
  attachments: ImageRef[];
  /** Captured when submitted, never when the asynchronous write finishes. */
  userEpoch: string | null;
  /** `user`, `runtime`, or an AgentId. */
  from: string;
  text: string;
  ts: Timestamp;
}

/** NEW name for `Message & { deliveryId }`. An inbox message with the file identity it was consumed under. */
export interface DeliveredMessage extends InboxMessage { deliveryId: string }

// ───────────────────────────── transcript ─────────────────────────────

/** SAME. protocol/transcript.ts. Entries form a tree through parentUuid; null is the root. */
export interface BaseEntry {
  uuid: string;
  parentUuid: string | null;
  ts: Timestamp;
  /** Inbox messages committed atomically with this entry; never model-visible. */
  inbox: DeliveredMessage[];
}

/** SAME. */
export interface MessageEntry extends BaseEntry {
  type: "message";
  message: MessageParam;
  /** Engine reference-context update, hidden from chat; not human input or authority. */
  contextSnapshot: string | null;
}

/** SAME. The model-summarized rest of the conversation a summary entry carries. */
export interface RollingMemory { summary: string[]; pending: string[] }

/** SAME. Read only, to seed the next summary; never written. */
export interface LegacyRollingMemory { user: string[]; project: string[]; pending: string[]; tasks: { id: string; notes: string }[] }

/** SAME. */
export interface SummaryEntry extends BaseEntry {
  type: "summary";
  text: string;
  /** Atomic context checkpoint; originals remain in the parent chain. Empty for a plain summary. */
  retained: MessageParam[];
  boundary: string | null;
  memory: RollingMemory | LegacyRollingMemory | null;
}

/** SAME. `branch` is null for the orchestrator. */
export interface MetaEntry extends BaseEntry { type: "meta"; role: Role; branch: Branch | null; model: ModelId }

/** SAME. What a turn sent the user; never reaches the model. */
export interface RepliesEntry extends BaseEntry {
  type: "replies";
  messages: { from: string; text: string; attachments: ImageRef[] }[];
}

/** SAME. Explicit reset of model context. */
export interface ContextBoundaryEntry extends BaseEntry { type: "context-boundary" }

/** NEW name for a shape defined twice today: inline in `ModelRequestEntry` and again as
 * `ModelRequestState` in core/tmux/exits.ts. */
export interface ModelRequestStage {
  model: ModelId;
  provider: ProviderName;
  stage: "preparing" | "provider-wait" | "completed" | "error" | "aborted";
  startedAt: Timestamp;
  updatedAt: Timestamp;
}

/** CHANGED: built from ModelRequestStage instead of repeating its fields. */
export interface ModelRequestEntry extends BaseEntry, ModelRequestStage { type: "model-request"; requestId: string }

/** SAME. Checkpoint after an interrupted final tool batch. */
export interface ToolRecoveryEntry extends BaseEntry { type: "tool-recovery"; messages: MessageParam[] }

/** SAME. (core/mcp/config.ts also exports an unrelated `Entry`; that one should become `ServerEntry`.) */
export type Entry = ToolRecoveryEntry | MessageEntry | SummaryEntry | MetaEntry | RepliesEntry | ContextBoundaryEntry | ModelRequestEntry;

/** CHANGED. An entry as passed to append(): uuid and ts are filled in. Today `parentUuid` is an optional
 * field meaning "the current head"; here it is gone, and the parent is an argument of append() instead. */
export type NewEntry = Entry extends infer E ? E extends Entry ? Omit<E, "uuid" | "ts" | "parentUuid"> : never : never;

/** SAME. A checkpoint is conditional on the head it was built from. `check` does nothing when there is nothing to check. */
export interface AppendGuard { head: string | null; check(): void }

// ───────────────────────────── model calls ─────────────────────────────

/** NEW name for the inline usage shape. A count the provider did not report is null, never zero. */
export interface TokenUsage { input: number; cachedInput: number | null; cacheWriteInput: number | null; output: number; reasoning: number | null }

/** MOVED. api/provider.ts. One model turn, Anthropic-shaped whatever the provider. */
export interface Turn {
  usage: TokenUsage | null;
  content: ContentBlock[];
  /** Whether the model wants tools run before it continues. */
  stop: "end" | "tool_use" | "limit" | "pause" | "refusal" | "error";
  inputTokens: number | null;
  /** Terminal provider reason; null only for legacy/custom providers. */
  completion: string | null;
}

/** NEW name for the inline trace shape. Accounting metadata only; never forwarded to the provider. */
export interface RequestTrace { project: ProjectId; agent: AgentId; run: RunId | null; purpose: string }

/** MOVED. api/provider.ts. */
export interface CompleteRequest {
  /** Null for a request made outside an agent (a probe, a test). */
  trace: RequestTrace | null;
  /** Stable local identity for cache routing; hashed before transport. Null turns cache routing off. */
  cacheScope: string | null;
  signal: AbortSignal;
  settings: RequestSettings;
  model: ModelId;
  /** The role's system prompt; providers put their own identity line first. Null for none. */
  system: string | null;
  messages: MessageParam[];
  tools: ApiTool[];
  maxTokens: number;
  onText(delta: string): void;
  /** A provider-side note that is not model text (a retry); shown as a plain status line. */
  onNotice(text: string): void;
}

/** MOVED. api/search/web-search.ts */
export interface SearchRequest { model: ModelId; settings: RequestSettings; query: string; maxResults: number; signal: AbortSignal }
/** MOVED. */
export interface SearchSource { url: string; title: string | null; excerpt: string | null }
/** MOVED. */
export interface SearchResult { sources: SearchSource[] }

// ───────────────────────────── tools ─────────────────────────────

/** MOVED. core/tools/registry.ts. Text, or text with references into the image store. */
export type ToolResult = string | (TextBlockParam | ImageBlockParam)[];

/** SAME. protocol/toolview.ts. A tool call as it starts. */
export interface ToolCall { id: string; name: string; input: unknown }
/** SAME. How it ended; `text` is the result as the model got it. */
export interface ToolOutcome { id: string; ok: boolean; text: string }
/** SAME. A finished call as shown. */
export interface ToolView { tool: string; summary: string; failed: boolean }

// ───────────────────────────── agents and runs ─────────────────────────────

/** MOVED. core/tmux/exits.ts. The latest run of one agent, as `runs/<agent>.json` holds it. */
export interface RunState {
  cwd: string | null;
  /** The latest model request; null before the first one. */
  modelRequest: ModelRequestStage | null;
  run: RunId;
  /** The agent process, so the watchdog can confirm it is gone. */
  pid: number;
  role: Role;
  /** Null for the orchestrator. */
  branch: Branch | null;
  /** "reported" when the agent's last act was a message to the orchestrator; any later activity makes it "running" again. */
  state: "running" | "reported";
  /** What it was doing last: a model request or a tool call. */
  step: string;
  /** The last tool call. */
  tool: string;
  /** Last update of this file. */
  ts: Timestamp;
  /** Null in files written before clocks existed. */
  startedAt: Timestamp | null;
  /** Null while it runs, and for a run nothing stamped (a hard kill). */
  endedAt: Timestamp | null;
}

/** SAME. protocol/agents.ts. One row of the Agents page. */
export interface AgentInfo {
  name: AgentId;
  live: boolean;
  run: RunId | null;
  status: "running" | "exited" | "unknown";
  /** Inventory read succeeded; individual rows may still have unknown activity. */
  inventoryComplete: boolean;
  /** Null when the inbox could not be read. */
  queuedMessages: number | null;
  activity: string | null;
  waitingForCommands: boolean;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
  /** endedAt is the run state's last update, not a recorded end. */
  approximateEnd: boolean;
  lastActiveAt: Timestamp | null;
  /** Its latest task is still open, so the page keeps showing it however old. */
  openTask: boolean;
  archived: boolean;
  retained: boolean;
}

// ───────────────────────────── tasks ─────────────────────────────

/** SAME. protocol/task/tasks.ts. The stored lifecycle stage. */
export type TaskStatus = "queued" | "working" | "reviewing" | "ready_to_merge";

/** SAME. protocol/task/task-ledger.ts. The one word shown to the user and the model. */
export type TaskDisplayStatus = "queued" | "working" | "waiting" | "pr open" | "merged" | "closed";

/** SAME. Why a task is held. */
export type AttentionKind = "waiting" | "blocked" | "cancelled" | "closed" | "unknown";
/** SAME. */
export interface TaskAttention { kind: AttentionKind; reason: string }

/** SAME. A verified PR identity; `head` is the commit it was seen at. */
export interface TaskPR { repository: string; number: number; url: string; head: string }

/** SAME. One launch of a worker or reviewer for a task. */
export interface TaskRun {
  /** Null for a worker run and for legacy runs. */
  reviewMode: "review" | "watch-ci" | null;
  id: RunId;
  agent: AgentId;
  role: "worker" | "reviewer";
  state: "prepared" | "started" | "stopped" | "failed";
  preparedAt: Timestamp;
  /** Null until the process confirmed it started; stays null for a launch that failed. */
  startedAt: Timestamp | null;
  /** Null while prepared or started. */
  endedAt: Timestamp | null;
}

/** SAME. Reviewer attestation for one exact head. */
export interface TaskReadiness { head: string; run: RunId; validatedAt: Timestamp; validation: string; checks: "passed" | "not_configured" }

/** SAME. One revision of a task; the fields it did not touch are null. */
export interface TaskEvent {
  revision: number;
  at: Timestamp;
  kind: string;
  status: TaskStatus;
  run: RunId | null;
  pr: TaskPR | null;
  attention: TaskAttention | null;
  readiness: TaskReadiness | null;
}

/** SAME. The last recorded verified publication. */
export interface TaskPublicationObservation { pr: TaskPR; state: "OPEN" | "CLOSED"; observedAt: Timestamp }

/** SAME shape; today it is reached as `LedgerTask["checkpoints"]`. First evidenced reach of each stage; null means not reached or unknown. */
export interface TaskCheckpoints { queuedAt: Timestamp | null; buildingAt: Timestamp | null; prOpenAt: Timestamp | null; mergedAt: Timestamp | null }

/** NEW name for the inline `archive` shape. */
export interface TaskArchive { reason: "merged"; mergedAt: Timestamp; archivedAt: Timestamp; pr: TaskPR }

/** SAME. */
export interface Task {
  readonly id: TaskId;
  /** The short project-local number; null in records older than numbering. */
  number: number | null;
  name: string;
  summary: string;
  branch: Branch;
  status: TaskStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
  /** Explicit prerequisite task ids. Not a scheduling signal. */
  dependsOn: TaskId[];
  runs: TaskRun[];
  pr: TaskPR | null;
  publication: TaskPublicationObservation | null;
  readiness: TaskReadiness | null;
  attention: TaskAttention | null;
  /** Start of an unpublished iteration; only an explicit publication receipt clears it. */
  iterationStartedAt: Timestamp | null;
  checkpoints: TaskCheckpoints;
  archive: TaskArchive | null;
  removedAt: Timestamp | null;
  history: TaskEvent[];
}

/** SAME. Where an unresolved review thread is. Its text stays on GitHub. `line` is null for a file-level thread. */
export interface ReviewThread { id: string; author: string; path: string; line: number | null; url: string }

/** SAME. A PR snapshot read from GitHub. */
export interface PRObservation {
  pr: TaskPR;
  branch: Branch;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: Timestamp | null;
  ready: boolean;
  checks: "passed" | "not_configured" | "pending" | "failed" | "unknown";
  /** "unknown" while GitHub has not computed it. */
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** "" when the repository requires no review. */
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  /** Fingerprint of review/comment activity; null when it was not read. */
  reviewActivity: string | null;
  /** Names of the checks that failed (at most eight). */
  failing: string[];
  draft: boolean;
  /** Unresolved review threads; null when they could not be read, which is not the same as none. */
  threads: ReviewThread[] | null;
}

// ───────────────────────────── questions ─────────────────────────────

/** RENAMED from `Status` (protocol/questions.ts). */
export type QuestionStatus = "open" | "answered" | "skipped";

/** SAME. */
export interface Question {
  id: string;
  text: string;
  /** Empty for a question answered by typing. */
  options: string[];
  /** A suggestion for an explicit answer only; never applied by silence. */
  default: string | null;
  status: QuestionStatus;
  answer: string | null;
  /** Why the orchestrator withdrew it; null for the user's own skip or delete. */
  reason: string | null;
  ts: Timestamp;
}
/** SAME. */
export type NewQuestion = Pick<Question, "text" | "options" | "default">;

// ───────────────────────────── projects ─────────────────────────────

/** MOVED. config/paths.ts. The checkout a conversation is bound to. An empty branch is a plain directory without Git. */
export interface RepositoryBinding { version: 1; directory: string; branch: Branch; worktreeId: string }

/** MOVED. config/directory-projects.ts. A folder project: the group conversations in one checkout share. */
export interface DirectoryProject {
  id: string;
  name: string;
  directory: string;
  branch: Branch;
  conversations: ProjectId[];
  incarnations: Record<ProjectId, string>;
  defaults: Record<string, unknown>;
  previousDirectories: { directory: string; branch: Branch }[];
}

/** SAME. protocol/projects.ts. A row of the project list. A conversation row has no directory and no members. */
export interface ProjectEntry { name: string; label: string; pinned: boolean; directory: string | null; conversations: ProjectId[] }

// ───────────────────────────── daemon channel ─────────────────────────────

/** SAME. protocol/daemon.ts */
export type DaemonState = "idle" | "turn" | "stopped";

/** SAME. Presentation only. `compacted` is the last finished compaction, null before the first. */
export interface OrchestratorActivity { working: boolean; compacting: boolean; compacted: { id: string; before: number; after: number } | null }

/** NEW name for the inline context shape. `used` is null when no estimate exists. */
export interface ContextUse { model: ModelId; used: number | null; window: ContextWindow }

/** SAME. `status.json`. */
export interface DaemonStatus {
  /** Null for a development process. */
  build: string | null;
  pid: number;
  run: RunId;
  state: DaemonState;
  /** When `state` began. */
  since: Timestamp;
  /** Turns started by this daemon. */
  turns: number;
  activity: OrchestratorActivity;
  /** The last turn's context estimate; null until a turn ran. */
  context: ContextUse | null;
  /** The last turn's failure, until the next turn; null when it succeeded. */
  error: string | null;
}

/** RENAMED from `Command` (tui/app-state.ts exports an unrelated `Command`: a slash command). */
export type DaemonCommand = { kind: "clear" } | { kind: "compact" } | { kind: "model"; model: ModelId } | { kind: "stop" };
/** RENAMED from `Request`. `run` names one exact daemon (update handoffs); null addresses whichever is running. */
export interface DaemonRequest { id: string; ts: Timestamp; command: DaemonCommand; run: RunId | null }
/** RENAMED from `Ack`. */
export interface DaemonAck { id: string; ok: boolean; message: string; at: Timestamp }

/** SAME. What happened during a turn. */
export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "status"; text: string }
  | { kind: "tool_start"; call: ToolCall }
  | { kind: "tool_end"; outcome: ToolOutcome }
  | { kind: "truncated" };
/** SAME. A line of `live.jsonl`. */
export type LiveEvent =
  | { seq: 0; kind: "start"; run: RunId; turn: number; at: Timestamp }
  | (TurnEvent & { seq: number; head: string | null });
/** SAME. */
export interface LiveKey { run: RunId; turn: number }

// ───────────────────────────── settings ─────────────────────────────

/** MOVED. config/config.ts. `~/.orca/.runtime/config.toml`, after defaults are applied. */
export interface Config {
  /** Full access preserves existing installs; workspace uses an OS write sandbox and fails closed if unavailable. */
  sandbox: "off" | "workspace";
  model: ModelId;
  compact: boolean;
  /** Upper working-context target for workers/reviewers. */
  workerContextTokens: number;
  contextLimitFallback: number;
  /** Old global Claude profile; read-only fallback for projects that never chose an account. "" is the default profile. */
  account: string;
  /** Old global Codex profile; same. */
  openaiAccount: string;
  anthropicPromptCache: boolean;
  /** Maximum overlap for calls marked independent; 1 is sequential. */
  toolConcurrency: number;
  maxToolOutputBytes: number;
  maxToolResultBytes: number;
  pinned: ProjectId[];
}
