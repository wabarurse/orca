// Shared TUI state and input helpers; rendering and event handling live in app.ts.
import type { TaskTreeRender, ClipboardImage, Key, Terminal } from "./components";
import type { ImageRef, AgentInfo, ProjectEntry, Message, ToolCall, ToolOutcome } from "../protocol";
import type { RequestSettings } from "../providers/catalog";
import type { Orchestrator } from "../core/agent-loop/orc";
import { cancelSession } from "../core/tmux";
import { allTasks, listTasks, removeTask } from "../core/data/tasks";
import type { FlowSettings } from "../core/data/projects";
import { login, sendAgentFeedback, modelChoices, effortChoices, setModel, type DeleteOptions } from "./commands";
import type { Line, MarkdownStream, Calls } from "./conversation";
import { editor as ed, type PageQuestions, type QuestionStore, type TaskInboxData, type CommandHelp, type Menu } from "./footer";

export interface Page {
  /** The project id: its folder under ~/.orca/projects. Never changes. */
  project: string;
  /** What the header tab shows; /rename sets it. */
  name: string;
  orch: Orchestrator;
  /** Repository remote, for the pinned header. */
  remote: string;
  /** Finished conversation lines, oldest first, retained while other pages are active. */
  lines: Line[];
  /** Last rendered clear boundary and request status; keep refreshes from reviving old UI state. */
  contextBoundary?: string;
  statusNotice?: string;
  /** The streaming reply: markdown blocks leave it as they complete; the rest shows raw in the live region. */
  md: MarkdownStream;
  busy: boolean;
  /** When the running turn started (clock ms), and whether its text has started streaming. */
  busySince: number;
  streamed: boolean;
  /** Set while the project list deletes this project: no new turns start. */
  deleting?: boolean;
  /** Input history (↑/↓), oldest first, saved in projects/<id>/input-history. */
  inputHistory: string[];
  /** Lines in the input-history file as far as this page knows, and the last write (writes go one at a time). */
  historyLines: number;
  savingHistory: Promise<void>;
  /** Submitted inbox prompts, previewed in the footer but not yet in history; removed by identity at onInbox. */
  sent: { readonly inputId: string; text: string; attachments?: ImageRef[]; submission?: string; retry?: boolean; question?: boolean }[];
  /** The orchestrator's open questions for the user, polled from questions/ (questions.ts). */
  questions: PageQuestions;
  /** Set while an agent's transcript is showing; calling leave returns to the page. */
  view: { name: string; lines: Line[]; leave: () => void; live: boolean; calls: Calls } | null;
  /** The orchestrator's tool calls running now, shown in the live region (tools.ts). */
  calls: Calls;
  model?: string;
  settings?: RequestSettings;
  /** The project's review-round limit and dynamic-dispatch switch (project-flow.ts) as last read; undefined = unknown, shown as "?". */
  review?: number;
  dispatch?: boolean;
  agentCount?: number;
}

export interface AppDeps {
  feedback?: typeof sendAgentFeedback;
  /** Completed drag or explicit Ctrl+O; tests inject a writer, never the live clipboard. */
  clipboardText?: (text: string) => Promise<void>;
  /** Explicit Ctrl+V only; tests inject fixture bytes, never the live clipboard. */
  clipboardImage?: () => Promise<ClipboardImage>;
  /** Cached header model accessor; defaults to effectiveModel(project). */
  projectModel?: (project: string) => Promise<string>;
  /** The project's saved review limit and /dynamic-dispatch switch (effectiveFlow by default); read outside paint, independent of task progress. */
  flowSettings?: (project: string) => Promise<FlowSettings>;
  term: Terminal;
  /** Bind a new project to a local checkout and build its orchestrator. */
  /** `write` gets streamed model text (markdown) and, with `plain` set, tool lines shown as they are; `onInbox` gets each batch of messages the orchestrator reads. */
  /** `tools` gets each tool call as it starts and ends: running in the live region, then its "⏺" line and summary in the history. */
  openOrchestrator(project: string, url: string | undefined, write: (text: string, plain?: boolean) => void, onInbox?: (msgs: Message[]) => void, tools?: ToolEvents): Promise<Orchestrator>;
  /** Inbox poll period; tests shorten it. */
  pollMs?: number;
  /** Original checkout directory: opened on start and shared by Ctrl+N conversations. */
  source?: string | null;
  /** Clock and repeating timer for the busy spinner; tests inject fakes so they never sleep. */
  clock?: Clock;
  /** A project's agents and which are live: /agents lists these and live views poll them. Defaults to listAgents for the menu and to tmux alone (liveAgents) for the poll. */
  cancelAgent?: typeof cancelSession;
  agents?: (project: string) => Promise<AgentInfo[]>;
  /** Sign-in; tests replace it. */
  login?: typeof login;
  modelChoices?: typeof modelChoices;
  effortChoices?: typeof effortChoices;
  modelAgents?: (project: string) => Promise<string[] | null>;
  saveModel?: typeof setModel;
  /** How the project list checks for live agents, stops a deleted project's orchestrator daemon and closes its tmux session; tests stub them. */
  projects?: Pick<DeleteOptions, "live" | "stop" | "kill">;
  /** Keeps each open project's orchestrator daemon running: called on open and each poll; returns a line to show when it did something (orchestrator-client.ts daemonKeeper). Absent in tests. */
  ensureDaemon?: (project: string) => Promise<string | undefined>;
  /** Extra per-poll watchers for every open page; production runs none here (the exit watchdog and merge watcher run in the orchestrator daemon). Tests inject them. */
  watchdog?: (project: string) => Promise<unknown>;
  merges?: (project: string) => Promise<unknown>;
  /** Where questions are read and answered (questions.ts on disk by default); tests stub it. */
  questions?: QuestionStore;
  /** Active structured task rows; read-only, defaults to the durable registry. */
  tasks?: typeof listTasks;
  treeTasks?: typeof allTasks;
  removeTask?: typeof removeTask;
  /** How long Enter, digits and typing are ignored after a question first shows (QUESTION_DELAY_MS); tests shorten it. */
  questionDelayMs?: number;
}

export interface ToolEvents { onRefresh?(): void; onTool(call: ToolCall): void; onToolResult(outcome: ToolOutcome): void; /** Runtime acknowledgements, progress and failures share the status row above the composer. */ notice?(text: string): void }

export interface Clock { now(): number; every(fn: () => void, ms: number): () => void }
/** A transient status note and whether a frame has drawn its row yet (only then does a key clear it). */
export interface Note { text: string; shown: boolean }

export const realClock: Clock = {
  now: () => Date.now(),
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** /review-rounds and /dynamic-dispatch are project settings: without a page there is nothing to show or change. */
export const NO_PAGE_FOR_SETTINGS = "open a project before changing its settings";
/** At most one frame per this many ms: stream chunks and spinner ticks coalesce. */
export const FRAME_MS = 16;
/** A resize reprints once it has settled for this long (trailing debounce). */
export const RESIZE_MS = 120;
export const SPIN_MS = 100;
/** The animation timer's period while something runs: the spinner steps every SPIN_MS, the shimmer moves every tick. */
export const TICK_MS = 33;
/** How often a live agent view checks whether its agent has finished. */
export const LIVE_CHECK_MS = 1000;
/** The open /agents menu redraws this often (its clocks tick in seconds) and re-reads the agent list every AGENTS_REFRESH_MS. */
export const AGENTS_TICK_MS = 1000;
export const AGENTS_REFRESH_MS = 2000;

/** The project list (Ctrl+B, /projects): every project on disk, pinned first. Takes the keys while open. */
export interface ProjectListState { items: ProjectEntry[]; index: number; status: string; confirm: ProjectEntry | null }

export interface ActiveMenu extends Menu {
  pick: (index: number) => Promise<void> | void;
  /** Set on the /agents menu, whose rows depend on the time: the rows at `now`, built per frame. `items` is then just the row count's source, as last built. */
  itemsAt?: (now: number) => string[];
  /** Set on the /agents menu: re-read the agent list and show it, keeping the selected agent by name. */
  reload?: () => Promise<void>;
}
export interface AgentsTimer { menu: ActiveMenu; readAt: number; reading: boolean; stop: () => void }
export interface TaskTreeState {
  page: Page; tasks: Awaited<ReturnType<typeof allTasks>>; selectedId?: string;
  graphX: number; graphY: number; detailY: number; loading: boolean; error?: string;
  collapsed: Set<string>; frame: number; detailsFocused?: boolean;
  confirmRemoval?: string; notice?: string; removing?: boolean;
  revealSelected?: boolean; rendered?: TaskTreeRender; reading?: Promise<void>; again?: boolean;
}

export interface TaskInboxState extends TaskInboxData {
  page: Page;
  top: number;
  content?: { cols: number; lines: string[]; heading?: string };
}

export interface ClearConfirmation {
  page: Page;
  identity: string;
  controller: AbortController;
  menu?: ActiveMenu;
  committing?: boolean;
}

/**
 * A slash command. Commands match by name (the text up to the first space).
 * Without `args` only the bare name matches: "/quit now" is an unknown command.
 * `run` gets the arguments trimmed ("" when none) and the active page, if any.
 */
export interface Command {
  run(args: string, page: Page | undefined): Promise<void> | void;
  /** Takes arguments: "/x" and "/x …" both match. */
  args?: true;
  /** Needs an open page: with none, a fresh orch-xxxx opens instead and the command is dropped (as for plain text and unknown commands). */
  needsPage?: true;
  /** Presentation only; arguments and guards remain in the command handler. */
  help: CommandHelp;
}

/** A typed line as a command: its name, trimmed arguments and table entry (none when unknown, or when it takes no arguments and got some); null for plain text. */
export function parseCommand(text: string, commands: ReadonlyMap<string, Command>): { name: string; args: string; command?: Command } | null {
  if (!text.startsWith("/")) return null;
  const name = text.split(" ")[0]!;
  const found = commands.get(name);
  const command = found && (found.args || text === name) ? found : undefined;
  return { name, args: text.slice(name.length).trim(), command };
}

/**
 * What a key means in the project list: a plain character's text or a named
 * key ("up", "enter", ...). Ctrl/Alt chords (and other single-letter chords)
 * mean nothing there, so Ctrl+D or Alt+Y never deletes.
 */
export const listKeyId = (k: Key): string | null => {
  if (k.ctrl || k.alt) return null;
  if (k.name === "char") return k.text ?? null;
  return k.name.length > 1 ? k.name : null;
};

/** One layer of key handling (App.keyLayers): `takes` only looks, `handle` acts. */
export interface KeyLayer { name: string; takes(k: Key): boolean; handle(k: Key): Promise<void> | void }

/** A menu key as up / down / enter / escape: k j q are ↑ ↓ Esc, Ctrl+P is ↑; other keys by name (doing nothing unless one of those). */
export const MENU_CHARS = new Map([["k", "up"], ["j", "down"], ["q", "escape"]]);
export const menuKeyId = (k: Key): string | undefined => {
  if (k.name === "char") return MENU_CHARS.get(k.text ?? "");
  return k.ctrl && k.name === "p" ? "up" : k.name;
};

/** A page shows activity while its turn runs or its agent view follows a live agent. */
export const active = (p: Page) => p.busy || !!p.view?.live;

/** Editing keys, as C- (Ctrl) M- (Alt) name; Shift is ignored. Plain Enter submits before this is reached. */
export const EDITS: Record<string, (s: ed.EditState) => ed.EditState> = {
  enter: ed.newline, "M-enter": ed.newline,
  backspace: ed.backspace, "M-backspace": ed.deleteWordBack, "C-backspace": ed.deleteWordBack, "C-h": ed.backspace,
  delete: ed.deleteForward, "M-d": ed.deleteWordForward,
  left: ed.left, right: ed.right,
  "M-left": ed.wordLeft, "C-left": ed.wordLeft, "M-b": ed.wordLeft,
  "M-right": ed.wordRight, "C-right": ed.wordRight, "M-f": ed.wordRight,
  home: ed.home, "C-a": ed.home, end: ed.end, "C-e": ed.end,
  "C-u": ed.killToStart, "C-k": ed.killToEnd, "C-w": ed.rubout,
};

/** The text a key types (a printable run or a paste), if any. */
export const typedText = (k: Key): string | undefined => ((k.name === "char" || k.name === "paste") && !k.ctrl && !k.alt ? k.text : undefined);

