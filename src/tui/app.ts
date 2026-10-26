import { ConversationSelection } from "./selection";
import { writeClipboardText, readClipboardImage, type ClipboardImage } from "../clipboard";
import { imageLabels, MAX_IMAGES, pendingImageInputs, saveImage, saveImageInput, type ImageRef } from "../images";
import { contextStatus, dispatchStatus, reviewStatus } from "./context-status";
import { listTasks } from "../tasks";
import { taskInboxLines, type TaskInboxData } from "./task-inbox";
import { cancelSession } from "../cancellation";
import { effortCommand, fastCommand, effectiveSettings, setEffort, type RequestSettings } from "../project-settings";
// Sticky top and bottom bars around a scrollable conversation. Only changed
// screen rows are redrawn; on exit the active transcript is printed back to
// the terminal's normal scrollback. One page per orchestrator: Ctrl+N starts one named
// orch-xxxx (/rename gives it a display name), Ctrl+Z and Ctrl+X move between
// them, Ctrl+B or /projects lists every project (open, pin, delete) like a
// menu. Type to talk to the page's orchestrator; worker and reviewer reports
// arrive through its inbox and show up while you wait. /help lists the commands.

import { accountChoices, deleteProject, type AgentInfo, displayName, listAgents, liveAgents, liveAgentsOrNull, listProjects, login, effortChoices, modelChoices, newProjectName, orderedProjects, projectFor, remoteOf, reviewRounds, dynamicDispatch, setDisplayName, setModel, shortRemote, togglePin, useAccount, validProjectName, type Choice, type DeleteOptions, type ProjectEntry } from "../commands";
import { loadConfig, paths, validRounds } from "../config";
import { projectIdentity } from "../project-state";
import { validateModel, effectiveModel } from "../project-model";
import type { Message } from "../inbox";
import type { Orchestrator } from "../orchestrator";
import type { Entry } from "../transcript";
import { format } from "node:util";
import { follow, parts } from "../view";
import * as ed from "./editor";
import type { Key } from "./keys";
import { historyRows, type Line, type Shown } from "./lines";
import { appendHistory, keepable, loadHistory, remember, MAX_INPUT_HISTORY } from "./history";
import { MarkdownStream } from "./mdstream";
import { helpLines, type CommandHelp } from "./help";
import { pageQuestions, Questions, QUESTION_DELAY_MS, QUESTION_PROGRESS, type PageQuestions, type QuestionStore } from "./questions";
import { replyLine, reportLine, restore, unresolvedCalls, userLines } from "./restore";
import { bold, commit, dim, fit, helpPanel, sanitize, taskInboxPanel, inputArea, inputGeometry, statusRows, type Frame, type Help, type TaskInboxView, type Input, type InputArea, type Menu } from "./render";
import type { Terminal } from "./term";
import { shimmer } from "./shimmer";
import { chapterRows, headerHeight } from "./chrome";
import { captureAnchor, resolveAnchor, type HistoryAnchor } from "./anchor";
import { Calls, collapseCalls } from "./tools";
import { agentRow, reselect } from "./agent-clock";
import type { ToolCall, ToolOutcome } from "../toolview";
import { stickyRows, stickyUpdate, type StickyScreen } from "./sticky";

export { helpLines } from "./help";
export { lineRows, type Line } from "./lines";

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
  /** Answered-question lines waiting for the streaming reply's partial line to end, so they never split it. */
  held: Line[];
  /** Set while an agent's transcript is showing; calling leave returns to the page. */
  view: { name: string; lines: Line[]; leave: () => void; live: boolean; calls: Calls } | null;
  /** The orchestrator's tool calls running now, shown in the live region (tools.ts). */
  calls: Calls;
  /** Ctrl+T: runs of finished calls show call by call instead of folded into one summary line (tools.ts `collapseCalls`). Per page, not saved. */
  toolsExpanded?: boolean;
  model?: string;
  settings?: RequestSettings;
  agentCount?: number;
}

export interface AppDeps {
  /** Completed drag or explicit Ctrl+O; tests inject a writer, never the live clipboard. */
  clipboardText?: (text: string) => Promise<void>;
  /** Explicit Ctrl+V only; tests inject fixture bytes, never the live clipboard. */
  clipboardImage?: () => Promise<ClipboardImage>;
  /** Cached header model accessor; defaults to effectiveModel(project). */
  projectModel?: (project: string) => Promise<string>;
  /** Saved global review limit; cached outside paint, independent of task progress. */
  reviewLimit?: () => Promise<number>;
  /** Saved global /dynamic-dispatch switch; cached like reviewLimit. */
  dispatchSetting?: () => Promise<boolean>;
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
  /** How long Enter, digits and typing are ignored after a question first shows (QUESTION_DELAY_MS); tests shorten it. */
  questionDelayMs?: number;
}

export interface ToolEvents { onRefresh?(): void; onTool(call: ToolCall): void; onToolResult(outcome: ToolOutcome): void; /** A retained status line for the page (the daemon's acknowledgements). */ notice?(text: string): void }

export interface Clock { now(): number; every(fn: () => void, ms: number): () => void }

const realClock: Clock = {
  now: () => Date.now(),
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** At most one frame per this many ms: stream chunks and spinner ticks coalesce. */
const FRAME_MS = 16;
/** A resize reprints once it has settled for this long (trailing debounce). */
const RESIZE_MS = 120;
const SPIN_MS = 100;
/** The animation timer's period while something runs: the spinner steps every SPIN_MS, the shimmer moves every tick. */
const TICK_MS = 33;
/** How often a live agent view checks whether its agent has finished. */
const LIVE_CHECK_MS = 1000;
/** The open /agents menu redraws this often (its clocks tick in seconds) and re-reads the agent list every AGENTS_REFRESH_MS. */
export const AGENTS_TICK_MS = 1000;
const AGENTS_REFRESH_MS = 2000;

/** The project list (Ctrl+B, /projects): every project on disk, pinned first. Takes the keys while open. */
interface ProjectListState { items: ProjectEntry[]; index: number; status: string; confirm: ProjectEntry | null }

interface ActiveMenu extends Menu {
  pick: (index: number) => Promise<void> | void;
  /** Set on the /agents menu, whose rows depend on the time: the rows at `now`, built per frame. `items` is then just the row count's source, as last built. */
  itemsAt?: (now: number) => string[];
  /** Set on the /agents menu: re-read the agent list and show it, keeping the selected agent by name. */
  reload?: () => Promise<void>;
}
interface AgentsTimer { menu: ActiveMenu; readAt: number; reading: boolean; stop: () => void }
interface TaskInboxState extends TaskInboxData {
  page: Page;
  top: number;
  pending?: Promise<void>;
  content?: { cols: number; lines: string[]; heading?: string };
}

interface ClearConfirmation {
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
const listKeyId = (k: Key): string | null => {
  if (k.ctrl || k.alt) return null;
  if (k.name === "char") return k.text ?? null;
  return k.name.length > 1 ? k.name : null;
};

/** One layer of key handling (App.keyLayers): `takes` only looks, `handle` acts. */
export interface KeyLayer { name: string; takes(k: Key): boolean; handle(k: Key): Promise<void> | void }

/** A menu key as up / down / enter / escape: k j q are ↑ ↓ Esc, Ctrl+P is ↑; other keys by name (doing nothing unless one of those). */
const MENU_CHARS = new Map([["k", "up"], ["j", "down"], ["q", "escape"]]);
const menuKeyId = (k: Key): string | undefined => {
  if (k.name === "char") return MENU_CHARS.get(k.text ?? "");
  return k.ctrl && k.name === "p" ? "up" : k.name;
};

/** A page shows activity while its turn runs or its agent view follows a live agent. */
const active = (p: Page) => p.busy || !!p.view?.live;

/** Editing keys, as C- (Ctrl) M- (Alt) name; Shift is ignored. Plain Enter submits before this is reached. */
const EDITS: Record<string, (s: ed.EditState) => ed.EditState> = {
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
const typedText = (k: Key): string | undefined => ((k.name === "char" || k.name === "paste") && !k.ctrl && !k.alt ? k.text : undefined);

export class App {
  pages: Page[] = [];
  private modelGeneration = 0;
  private clearing?: ClearConfirmation;
  private _active = 0;
  get active(): number { return this._active; }
  set active(index: number) {
    if (index !== this._active) { this.clipboardGeneration++; if (this.page) this.questions.hide(this.page); this.cancelClear(); this.modelGeneration++; this.helpTop = null; this.taskInbox = null; }
    this._active = index;
  }
  private looseLines: string[] = [];
  input = { text: "", cursor: 0 };
  /** First input row on screen, kept between frames so the input area scrolls only when the cursor leaves it. */
  private inputTop: number | undefined;
  /** Null until explicitly opened; only a footer scroll position, never a history line. */
  private helpTop: number | null = null;
  /** One explicit panel, owned by the captured page object; never reused across projects. */
  private taskInbox: TaskInboxState | null = null;
  private helpContent?: { cols: number; inView: boolean; lines: string[] };
  menu: ActiveMenu | null = null;
  projectList: ProjectListState | null = null;
  loggingIn = false;
  /** Text typed while signing in, per page; sent when sign-in succeeds, dropped when it fails. */
  private readonly queued = new Map<Page, { text: string; submission?: string; inputId: string; attachments?: ImageRef[] }[]>();
  private readonly draftImages = new WeakMap<Page, ImageRef[]>();
  private clipboardGeneration = 0;
  private clipboardReading = false;
  private readonly sending = new WeakMap<Page, Promise<void>>();
  private images(page = this.page): ImageRef[] { return page ? this.draftImages.get(page) ?? [] : []; }
  private imageOwner(page: Page, generation: number): boolean {
    return generation === this.clipboardGeneration && this.page === page && this.validPage(page)
      && !page.view && !this.menu && !this.projectList && !this.clearing && !this.taskInbox
      && this.helpTop === null && !page.questions.expanded;
  }
  private async pasteImage(): Promise<void> {
    const page = this.page;
    if (!page || page.view || page.questions.expanded) return this.say(dim("open a project chat before attaching an image (not a question answer)."));
    if (this.clipboardReading) return this.say(dim("an image read is already in progress; ctrl+v again when it finishes."));
    if (this.images(page).length >= MAX_IMAGES) return this.say(dim("at most 4 images per prompt; ctrl+y removes the last image."));
    const generation = ++this.clipboardGeneration;
    this.clipboardReading = true;
    try {
      const identity = projectIdentity(page.project);
      const image = await (this.deps.clipboardImage ?? readClipboardImage)();
      if (!this.imageOwner(page, generation)) return;
      if (projectIdentity(page.project) !== identity) throw new Error("project changed; image not attached.");
      const ref = await saveImage(page.project, image.bytes, image.mime);
      if (!this.imageOwner(page, generation)) return;
      this.draftImages.set(page, [...this.images(page), ref]);
    } catch (error) {
      if (this.imageOwner(page, generation)) this.say(dim(`image not attached: ${error instanceof Error ? error.message : error}`), page);
    } finally { this.clipboardReading = false; this.draw(); }
  }
  private removeImage(): void {
    const page = this.page;
    if (page && !page.questions.expanded && !page.view) this.draftImages.set(page, this.images(page).slice(0, -1));
    this.draw();
  }
  private async recoverImages(page: Page): Promise<void> {
    const inputs = await pendingImageInputs(page.project, page.orch.consumed?.());
    if (!this.validPage(page)) return;
    for (const input of inputs) if (!page.orch.consumed?.().has(input.inputId)
      && !page.sent.some(m => m.inputId === input.inputId) && !this.queued.get(page)?.some(m => m.inputId === input.inputId)) {
      page.sent.push({ ...input, retry: true });
    }
  }
  private async retryImages(page?: Page): Promise<void> {
    if (!page || page.view || this.loggingIn) return this.say(dim("open project chat and finish sign-in before retrying images."));
    await this.recoverImages(page);
    for (const item of [...page.sent]) if (item.attachments?.length && item.retry) {
      await this.send(page, item.text, item.submission, item.inputId, item.attachments).catch(error => this.say(dim(String(error)), page));
    }
    this.runTurn(page);
  }
  /** /keys: echo every key as parsed until Esc, to see what a terminal really sends. */
  keyEcho = false;
  /** Input history while no page is open; a page keeps its own. */
  private looseHistory: string[] = [];
  /** How far back ↑ has gone (-1: not recalling), and in whose history. */
  private historyAt = -1;
  private historyPage: Page | undefined;
  private done!: () => void;
  private readonly finished: Promise<void>;
  private readonly loginAbort = new AbortController();
  private frameQueued = false;
  /** When the last frame was written (wall clock), for the frame throttle. */
  private lastFrame = 0;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending resize reprint; nothing is drawn until it fires, as the old geometry is stale. */
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Finished rows not yet added to the active viewport's rendered history. */
  private pending: string[] = [];
  /** Rebuild the rendered history on the next draw (switches, resizes, agent views). */
  private needReprint = false;
  /**
   * Set once pages and terminal background are ready. Until then show only
   * startup notes and transient "opening…" activity at the conversation tail.
   */
  private started = false;
  private stopSpinner: (() => void) | null = null;
  /** The open /agents menu's redraw timer; null whenever that menu is not the open overlay. */
  private agentsTimer: AgentsTimer | null = null;
  private tickMs = 0;
  private screen: StickyScreen | undefined;
  private screenHistory: string[] = [];
  private screenOwner: Page | Page["view"] | undefined;
  private scrollTop: number | null = null;
  private scrollAnchor?: HistoryAnchor;
  private liveCheckedAt = 0;
  /** Liveness checks still running, per project; a tick skips a project while its last check is pending. */
  private readonly liveChecks = new Map<string, Promise<void>>();
  private closed = false;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshForce = false;
  private maxReviewRounds?: number;
  private reviewVersion = 0;
  private dynamicDispatch?: boolean;
  private dispatchVersion = 0;
  private readonly deferredRefresh = new Set<Page>();
  private readonly renderedHeads = new WeakMap<Page, string | undefined>();
  private readonly refreshedTurns = new WeakSet<Page>();
  /** Pages whose last rendering left out calls the running turn has not finished (they show as running rows instead); re-rendered once the turn ends. */
  private readonly hidRunning = new WeakSet<Page>();
  private readonly notices = new WeakMap<Page, Line[]>();
  /** Each page's transient status note (one row above the composer; the next keypress on that page clears it), and the one shown while no page is open. */
  private readonly notes = new WeakMap<Page, string>();
  private looseNote: string | undefined;

  /** The active page's oldest open question in the live region, and the keys it takes (questions.ts). */
  readonly questions: Questions;

  constructor(private readonly deps: AppDeps) {
    this.finished = new Promise<void>((r) => (this.done = r));
    const app = this;
    this.questions = new Questions({
      page: () => app.page,
      valid: page => !app.closed && app.pages.includes(page as Page) && !(page as Page).deleting,
      opening: () => { app.cancelClear(); app.modelGeneration++; app.taskInbox = null; app.helpTop = null; app.menu = null; app.projectList = null; },
      get input() { return app.input; },
      set input(v) { app.input = { text: v.text, cursor: v.cursor }; },
      say: (line, page) => app.toPage(page as Page, [line]),
      record: (line, page) => app.record(page as Page, line),
      queue: (page, inputId, text) => { (page as Page).sent.push({ inputId, text, question: true }); app.draw(); },
      unqueue: (page, inputId) => { const sent = (page as Page).sent; const at = sent.findIndex(m => m.inputId === inputId); if (at !== -1) sent.splice(at, 1); },
      submitted: () => { void app.refreshSessions(); },
      width: () => app.inputWidth("answer> "),
      now: () => app.clock.now(),
      isCommand: (text) => app.commands.has(text.split(" ")[0]!),
      run: (text) => { app.remember(text); return app.submit(text); },
      draw: () => app.draw(),
    }, deps.questions, deps.questionDelayMs ?? QUESTION_DELAY_MS);
  }

  get page(): Page | undefined { return this.pages[this.active]; }

  private get clock(): Clock { return this.deps.clock ?? realClock; }

  /** Run until /quit; opens the given project, or every known one plus the repo we were started in, or a fresh orch-xxxx. */
  async run(project?: string, url?: string): Promise<void> {
    const { term } = this.deps;
    term.open();
    const restoreConsole = this.captureConsole();
    term.onKey((k) => { this.onKey(k).catch((err) => this.say(`error: ${err instanceof Error ? err.message : String(err)}`)); });
    term.onResize(() => this.resized());
    const poll = setInterval(() => {
      if (this.page) this.checkLive(this.page.project);
      this.watchPages();
      this.questions.poll(this.pages);
      void this.refreshSessions(false); // passive snapshots also follow responses consumed in another window
      if (!this.loggingIn) this.runPending();
    }, this.deps.pollMs ?? 2000);
    try {
      this.draw(); // "opening…" at once
      const shaded = term.background?.then(() => this.draw()); // the input in the terminal's shade as soon as it is known
      await this.openStartPages(project, url);
      await shaded; // restored user rows first enter the viewport in the resolved shade
      this.started = true;
      this.needReprint = true;
      this.draw();
      await this.finished;
    } finally {
      clearInterval(poll);
      this.closed = true;
      for (const t of [this.frameTimer, this.resizeTimer]) if (t) clearTimeout(t);
      this.stopSpinner?.();
      this.stopSpinner = null;
      this.syncAgentsTimer();
      this.loginAbort.abort();
      // Closing the TUI leaves the orchestrator daemon and its turn running; dispose only stops following.
      for (const p of this.pages) { p.orch.dispose?.(); p.view?.leave(); }
      restoreConsole();
      term.close();
      this.leave();
    }
  }

  /** The given project, or every known one plus the repo we were started in, or a fresh orch-xxxx. */
  private async openStartPages(project?: string, url?: string): Promise<void> {
    if (project) { await this.openPage(project, url); return; }
    for (const name of await listProjects()) {
      try { await this.openPage(name); }
      catch (error) { this.say(`could not open ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const source = this.deps.source;
    if (source) {
      // Reuse by original checkout path, never by origin (another clone may share it).
      const existing = await projectFor(source);
      if (existing) await this.openPage(existing);
      else await this.newPage();
    }
    if (!this.pages.length) await this.newPage();
  }

  /**
   * Route console output (e.g. the config loader's warning) into conversation
   * history while the TUI runs, so nothing writes behind the pinned renderer's
   * back. Returns the undo.
   */
  private captureConsole(): () => void {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => { for (const l of format(...args).split("\n")) this.say(l); };
    return () => methods.forEach((m, i) => { console[m] = saved[i]!; });
  }

  quit(): void { this.taskInbox = null; this.cancelClear(); this.modelGeneration++; this.done(); }

  // --- output -----------------------------------------------------------------

  /** Append a finished line to the page's agent view if one is up, else to the page (or the screen when there is none). */
  say(line: string, page = this.page): void {
    if (!page) { this.looseLines.push(line); this.pending.push(line); return this.draw(); }
    if (page.view) this.toView(page, page.view, [line]);
    else { this.keepNotice(page, line); this.toPage(page, [line]); }
  }

  /**
   * An informational status note ("model set to …", a rename, what the daemon
   * keeper did): one dim row directly above the composer, replacing the page's
   * previous note, never in the conversation or its restored history. Like the
   * project list's status, the next keypress clears it; a mouse event does not.
   */
  note(text: string, page = this.page): void {
    if (page) this.notes.set(page, text); else this.looseNote = text;
    this.draw();
  }

  /** The next keypress on the page clears its note; scrolling (wheel, page keys) and mouse selection leave it. */
  private clearNote(k: Key): void {
    if (/^(?:wheel|mouse|page)/.test(k.name)) return;
    const page = this.page;
    if (page ? !this.notes.delete(page) : this.looseNote === undefined) return;
    if (!page) this.looseNote = undefined;
    this.draw();
  }

  /** The shown page's note, cut to one row. */
  private noteRow(page: Page | undefined): string | undefined {
    const text = page ? this.notes.get(page) : this.looseNote;
    return text === undefined ? undefined : dim(fit(sanitize(text.replace(/\s*\n\s*/g, " ")), this.deps.term.cols));
  }

  private keepNotice(page: Page, line: Line): void {
    const notes = this.notices.get(page) ?? [];
    notes.push(line); this.notices.set(page, notes);
  }

  /** Finished lines of the page's own history; they reach the screen only while it is active and shows no agent. */
  private toPage(page: Page, lines: Line[]): void {
    const previous = page.lines.at(-1);
    page.lines.push(...lines);
    if (this.started && page === this.page && !page.view) this.append(page, lines, previous);
    this.draw();
  }

  /** Finished lines of an agent view; on screen only while it is what the active page shows. */
  private toView(page: Page, view: NonNullable<Page["view"]>, lines: Line[]): void {
    const previous = view.lines.at(-1);
    view.lines.push(...lines);
    if (this.started && page === this.page && page.view === view) this.append(page, lines, previous);
    this.draw();
  }

  /** New lines onto the screen: appended rows, unless they fold into the run of calls already drawn (its summary row changes), which needs a reprint. */
  private append(page: Page, lines: Line[], previous?: Line): void {
    const run = previous === undefined ? lines : [previous, ...lines];
    if (!page.toolsExpanded && collapseCalls(run).length !== run.length) this.needReprint = true;
    else this.pending.push(...this.rows(lines, previous));
  }

  /** The lines a page shows (its agent view's, else its own): runs of finished calls folded into one line each unless the page is expanded (Ctrl+T). */
  private shown(page: Page, lines = page.view?.lines ?? page.lines): readonly Shown[] {
    return page.toolsExpanded ? lines : collapseCalls(lines);
  }

  /** What the screen shows for the active page: its agent view or its history. */
  private screenLines(page = this.page): string[] {
    return page ? this.rows(this.shown(page)) : this.looseLines;
  }

  /** History lines laid out at the terminal's width. */
  private rows(lines: readonly Shown[], previous?: Shown): string[] {
    return historyRows(lines, this.deps.term.cols, previous);
  }

  /**
   * Streamed output. Model text is markdown: each block goes into the history
   * once complete, the rest waits in `page.md` (shown raw in the live region).
   * `plain` text (tool calls) ends the markdown and is shown as is.
   */
  private stream(page: Page, text: string, plain = false): void {
    page.streamed = true;
    if (!plain) return this.toPage(page, page.md.feedLines(text));
    this.endPartial(page);
    this.toPage(page, text.replace(/\n$/, "").split("\n"));
  }

  /** Consumption is the only normal path from a queued prompt to conversation history. */
  private inbox(page: Page, msgs: Message[]): void {
    this.endPartial(page);
    for (const m of msgs) {
      if (m.from !== "user") { this.toPage(page, [reportLine(m.from, m.text)]); continue; }
      // Match identity, not text: an identical external message is not an acknowledgement.
      // Typed here: show only now, at the consumption boundary (answer-shaped chat stays chat).
      // A question answered here leaves the queue the same way; its line was shown when answered.
      const at = m.inputId ? page.sent.findIndex(item => item.inputId === m.inputId) : -1;
      const item = at === -1 ? undefined : page.sent.splice(at, 1)[0];
      if (item && !item.question) { this.toPage(page, userLines([m.text, imageLabels(m.attachments)].filter(Boolean).join("\n"))); continue; }
      // A question's answer: its dim line, unless answered here (shown then); anything else from elsewhere (`orca msg`) as "> …", as restore shows it.
      this.toPage(page, this.questions.inboxLines(page, [m.text, imageLabels(m.attachments)].filter(Boolean).join("\n")) ?? userLines(m.text));
    }
  }

  /** A tool call started: it ends the streamed text and runs in the live region until it ends. */
  private toolStarted(page: Page, call: ToolCall): void {
    page.streamed = true;
    this.endPartial(page);
    page.calls.start(call);
    this.draw();
  }

  /** Move what a page's stream still holds into its history. */
  private endPartial(page: Page): void {
    const blocks = page.md.flushLines();
    if (blocks.length) this.toPage(page, blocks);
    if (page.held.length) this.toPage(page, page.held.splice(0));
  }

  /** An answered question's line: into the page's history now, or once the reply streaming there ends its partial line. */
  private record(page: Page, line: Line): void {
    this.keepNotice(page, line);
    if (page.md.pending) page.held.push(line);
    else this.toPage(page, [line]);
  }

  frame(): Frame {
    const page = this.page;
    const status = this.started && page ? this.status(page) : null;
    const refs = this.images(page);
    const showImages = refs.length > 0 && !page?.questions.expanded;
    const note = this.noteRow(page);
    const { input, area } = this.inputFrame(statusRows(status, this.deps.term.cols, this.composerRows()).length + (showImages ? 1 : 0) + (note ? 1 : 0));
    if (showImages) {
      area.lines.unshift(dim(`${imageLabels(refs)} · ctrl+y remove last`.slice(0, this.deps.term.cols)));
      area.row++;
    }
    if (note) { area.lines.unshift(note); area.row++; }
    return {
      cols: this.deps.term.cols, rows: this.deps.term.rows,
      partial: page && !page.view ? page.md.pending : "",
      running: page ? (page.view?.calls ?? page.calls).rows(this.clock.now(), this.deps.term.cols) : [],
      activity: !this.started ? dim("opening…") : page ? this.activity(page) : undefined,
      welcome: this.started && !!page && this.newChat(page),
      status, input, inputArea: area,
      // Project-owned submitted text only: never reconstruct from conversation
      // user lines or from the chat/answer draft. This is presentation, not delivery.
      queued: page ? { project: page.name, texts: [...page.sent.map(item => `${item.retry ? "[not confirmed; /retry-images] " : ""}${item.text}${item.attachments?.length ? " " + imageLabels(item.attachments) : ""}`), ...(this.queued.get(page) ?? []).map(item => `${item.text}${item.attachments?.length ? " " + imageLabels(item.attachments) : ""}`)] } : undefined,
      menu: this.menuView(),
      help: this.helpView(),
      inbox: this.taskInboxView(),
      question: this.questions.view(),
      projects: this.projectList && {
        index: this.projectList.index, status: this.projectList.status,
        items: this.projectList.items.map((it) => {
          const at = this.pages.findIndex((p) => p.project === it.name);
          return { ...it, open: at !== -1, active: at === this.active, busy: !!this.pages[at]?.busy };
        }),
      },
    };
  }

  private header(page: Page, decorate = true): string[] {
    const settings = page.settings;
    const model = `${page.model ?? "loading model…"} · effort ${settings ? settings.effort ?? "default" : "…"} · fast ${settings ? settings.fast ? "on" : "off" : "…"}`;
    return chapterRows({ tabs: this.pages, active: this.pages.indexOf(page), model, context: this.contextLabel(page), review: reviewStatus(this.maxReviewRounds), dispatch: dispatchStatus(this.dynamicDispatch), directory: paths.repo(page.project), remote: page.remote ? shortRemote(page.remote) : "no remote", agent: page.view?.name, fin: decorate && !this.newChat(page) ? { time: this.clock.now(), active: page.view ? page.view.live : page.busy } : undefined }, this.deps.term.cols, headerHeight(this.deps.term.rows));
  }

  /** Submission hides the welcome immediately, even before inbox consumption. */
  private newChat(page: Page): boolean {
    return !page.view && !page.lines.length && !page.md.pending && !page.busy && !page.calls.size && !page.sent.length && !this.queued.get(page)?.length;
  }

  /** Independent read generations for captured page objects. */
  private readonly modelVersions = new WeakMap<Page, number>();

  private readModel(project: string): Promise<string> {
    return this.deps.projectModel?.(project) ?? effectiveModel(project);
  }

  /** Refresh after a confirmed save or poll; late reads cannot overwrite newer captured-page state. */
  async refreshHeader(page = this.page): Promise<void> {
    if (!page) return;
    const version = (this.modelVersions.get(page) ?? 0) + 1;
    this.modelVersions.set(page, version);
    const model = await this.readModel(page.project);
    const settings = await effectiveSettings(page.project, model).catch(() => undefined);
    if (this.modelVersions.get(page) !== version || !this.pages.includes(page) || page.deleting) return;
    const unchanged = model === page.model && JSON.stringify(settings) === JSON.stringify(page.settings);
    page.model = model;
    page.settings = settings;
    if (!unchanged && page === this.page) this.draw();
  }

  /** Agent views show no session context; otherwise the orchestrator's own compaction limit. */
  private contextLabel(page: Page): string {
    if (page.view || !page.model) return contextStatus(undefined);
    return contextStatus(page.model, page.orch.contextUsage?.(page.model), page.orch.contextWindow?.(page.model));
  }

  /** One global snapshot for all pages and agent views; no config reads during paint.
   * A slow pre-save/pre-refresh read must never replace a newer observation. */
  private async refreshReviewRounds(): Promise<void> {
    const version = ++this.reviewVersion;
    let rounds: number | undefined;
    try {
      const saved = await (this.deps.reviewLimit?.() ?? loadConfig().then(config => config.maxReviewRounds));
      if (validRounds(saved)) rounds = saved;
    } finally {
      if (version === this.reviewVersion && !this.closed && this.maxReviewRounds !== rounds) {
        this.maxReviewRounds = rounds;
        this.draw();
      }
    }
  }

  private async reviewRoundsCommand(args: string, page = this.page): Promise<void> {
    ++this.reviewVersion; // invalidate observations started before this save
    this.say(dim(await reviewRounds(args)), page);
    await this.refreshReviewRounds(); // read the saved value, never infer success from input
  }

  /** Same snapshot, race and failure rules as refreshReviewRounds. */
  private async refreshDynamicDispatch(): Promise<void> {
    const version = ++this.dispatchVersion;
    let on: boolean | undefined;
    try {
      const saved = await (this.deps.dispatchSetting?.() ?? loadConfig().then(config => config.dynamicDispatch));
      if (typeof saved === "boolean") on = saved;
    } finally {
      if (version === this.dispatchVersion && !this.closed && this.dynamicDispatch !== on) {
        this.dynamicDispatch = on;
        this.draw();
      }
    }
  }

  private async dynamicDispatchCommand(args: string, page = this.page): Promise<void> {
    ++this.dispatchVersion; // invalidate observations started before this save
    this.say(dim(await dynamicDispatch(args)), page);
    await this.refreshDynamicDispatch(); // read the saved value, never infer success from input
  }

  private spinner(): string { return SPINNER[Math.floor(this.clock.now() / SPIN_MS) % SPINNER.length]!; }

  /** Counts only: no shortcuts, repeated identities or transient animation in the footer. */
  status(page: Page): string {
    const agents = page.agentCount ?? 0;
    const queued = page.sent.length + (this.queued.get(page)?.length ?? 0);
    const known = (p: Page) => p.questions.loaded && !p.questions.error;
    const questions = known(page) ? page.questions.open.length : "?";
    const background = this.pages.filter(p => p !== page);
    const elsewhere = background.reduce((n, p) => n + (known(p) ? p.questions.open.length : 0), 0);
    const unknown = background.some(p => !known(p));
    return [`${agents} ${agents === 1 ? "agent" : "agents"} running`, `${queued} ${queued === 1 ? "message" : "messages"} queued`, `inbox ${questions}${elsewhere || unknown ? ` (+${elsewhere || ""}${unknown ? (elsewhere ? "+?" : "?") : ""} elsewhere)` : ""}`].join(" │ ");
  }

  /** Only the selected conversation can animate; tool rows already carry their own shimmer. */
  activity(page: Page): string | undefined {
    if ((page.view?.calls ?? page.calls).size) return undefined;
    if (page.view) return page.view.live ? dim(`${this.spinner()} ${shimmer("working…", this.clock.now())}`) : undefined;
    return page.busy ? dim(this.turnStatus(page)) : undefined;
  }

  /** Fast frames only for visible animation, never because a background page is busy. */
  private shimmering(): boolean {
    const page = this.page;
    return !!page && (!!(page.view?.calls ?? page.calls).size || !!this.activity(page));
  }

  /** "⠋ thinking… 3s" with the word shimmering; the surrounding dim resumes after it. */
  private turnStatus(page: Page): string {
    const now = this.clock.now();
    const word = shimmer(page.streamed ? "working…" : "thinking…", now);
    return `${this.spinner()} ${word}\x1b[2m ${Math.floor((now - page.busySince) / 1000)}s`;
  }

  /** Run the spinner timer only while some page is busy or viewing a live agent. */
  private animate(): void {
    this.syncAgentsTimer();
    const fast = this.shimmering();
    const ms = fast ? TICK_MS : SPIN_MS;
    const want = !this.closed && (fast || this.pages.some(active));
    if (this.tickMs !== ms || !want) { this.stopSpinner?.(); this.stopSpinner = null; }
    this.tickMs = ms;
    if (want && !this.stopSpinner) this.stopSpinner = this.clock.every(() => this.tick(), ms);
  }

  /** Tick the open /agents menu (and only it) once a second, re-reading its list every other second. */
  private syncAgentsTimer(): void {
    const menu = !this.closed && this.menu?.reload ? this.menu : null;
    if (this.agentsTimer?.menu === menu) return;
    this.agentsTimer?.stop();
    this.agentsTimer = null;
    if (!menu) return;
    const timer = { menu, readAt: this.clock.now(), reading: false, stop: () => {} };
    timer.stop = this.clock.every(() => this.agentsTick(timer), AGENTS_TICK_MS);
    this.agentsTimer = timer;
  }

  private agentsTick(timer: AgentsTimer): void {
    if (this.agentsTimer !== timer) return;
if (this.menu !== timer.menu) return this.draw(); // closed (e.g. Enter, while pick runs): the draw syncs the timer off
    const now = this.clock.now();
    if (!timer.reading && now - timer.readAt >= AGENTS_REFRESH_MS) {
      timer.readAt = now;
      timer.reading = true;
      void timer.menu.reload!().catch(() => {}).finally(() => { timer.reading = false; this.draw(); });
    }
    this.draw();
  }

  private tick(): void {
    const now = this.clock.now();
    if (now - this.liveCheckedAt >= LIVE_CHECK_MS) {
      this.liveCheckedAt = now;
      for (const project of new Set(this.pages.filter((p) => p === this.page || p.view?.live).map((p) => p.project))) this.checkLive(project);
    }
    this.draw();
  }

  /** One agents call per project, never overlapping: mark views whose agent has finished. */
  private checkLive(project: string): void {
    if (this.liveChecks.has(project)) return;
    const agents = this.deps.agents ?? (async (p: string) => (await liveAgents(p)).map((name) => ({ name, live: true })));
    const check = agents(project)
      .then((agents) => {
        const live = new Set(agents.filter((a) => a.live).map((a) => a.name));
        for (const p of this.pages) if (p.project === project) p.agentCount = [...live].filter((n) => /^(worker|reviewer)(-|$)/.test(n)).length;
        this.draw();
        for (const p of this.pages) if (p.project === project && p.view?.live && !live.has(p.view.name)) { p.view.live = false; this.draw(); }
      })
      .catch(() => {})
      .finally(() => this.liveChecks.delete(project));
    this.liveChecks.set(project, check);
  }

  /** The input and its laid-out area, keeping the window's top row between frames. */
  private inputFrame(reserved: number): { input: Input; area: InputArea } {
    const input: Input = { prompt: this.prompt(), text: this.input.text, cursor: this.input.cursor, top: this.inputTop };
    const area = inputArea(input, this.deps.term.cols, this.composerRows(), reserved);
    input.top = this.inputTop = area.top;
    return { input, area };
  }

  /** Same available height as stickyRows: fixed header, plus at least one body row. */
  private composerRows(): number {
    return Math.max(1, this.deps.term.rows - (this.page ? this.header(this.page).length : 0) - 1);
  }

  private inputWidth(prompt: string): number {
    return inputGeometry(prompt, this.deps.term.cols, this.composerRows()).width;
  }

  private prompt(): string {
    const view = this.page?.view;
    if (this.questions.answering()) return dim("answer> ");
    return view ? dim(`${view.name} > `) : dim("> ");
  }

  /** Coalesce changed pinned rows and the conversation viewport into the next frame. */
  draw(): void {
    if (this.closed) return;
    this.questions.sync(); // the input holds the chat draft or the shown question's answer, as the state now wants
    this.animate();
    if (this.frameQueued || this.resizeTimer) return;
    this.frameQueued = true;
    // Throttled: the first draw after a quiet spell goes at once, a burst coalesces into one frame per FRAME_MS.
    const wait = Math.max(0, this.lastFrame + FRAME_MS - Date.now());
    this.frameTimer = setTimeout(() => {
      this.frameQueued = false;
      this.frameTimer = null;
      if (!this.closed && !this.resizeTimer) this.flush();
    }, wait);
  }

  /** Reflow the active conversation while preserving the bars and shell scrollback. */
  reprint(): void {
    if (!this.started) return this.draw(); // nothing of ours is on screen yet but the live region
    this.needReprint = true;
    this.draw();
  }

  /** A resize: wait until it settles, drawing nothing meanwhile (the old region's rows no longer match), then reprint. */
  private resized(): void {
    this.selection.clear();
    if (this.closed) return;
    this.cancelClear();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.reprint(); }, RESIZE_MS);
  }

  private flush(): void {
    this.lastFrame = Date.now();
    try {
      this.questions.sync(); // the input holds the chat draft or the shown question's answer
      const next = this.viewport(this.frame());
      const output = stickyUpdate(next, this.screen);
      this.needReprint = false;
      // Synchronized output, so the terminal shows the whole update at once.
      if (output) this.deps.term.write(`\x1b[?2026h${output}\x1b[?2026l`);
      this.screen = next;
      this.deps.term.eraseOnExit("");
    } catch (err) {
      // A bad frame must not take the app down. Its lines are still in the page's history; say so once and reprint next time.
      const note = `error drawing the screen: ${err instanceof Error ? err.message : String(err)}`;
      this.screen = undefined;
      if (this.started) this.needReprint = true;
      if (note !== this.drawError) { this.drawError = note; this.say(dim(note)); }
    }
  }

  private readonly selection = new ConversationSelection();

  private selectionAllowed(): boolean {
    return !this.clearing && !this.keyEcho && !this.menu && !this.projectList && this.helpTop === null && !this.taskInbox && !this.page?.questions.expanded;
  }

  private validateSelection(owner: typeof this.screenOwner, cols: number): void {
    if (!this.selectionAllowed() || owner !== this.screenOwner || this.screen?.cols !== cols) this.selection.clear();
  }

  private viewport(f: Frame): StickyScreen {
    const owner = this.page?.view ?? this.page;
    this.validateSelection(owner, f.cols);
    this.anchorScroll(owner, f.cols);
    if (this.needReprint || owner !== this.screenOwner) this.screenHistory = this.started ? this.screenLines() : [...this.looseLines];
    else this.screenHistory.push(...this.pending);
    this.screenOwner = owner;
    this.pending = [];
    const chrome = this.page ? this.header(this.page) : [];
    const screen = stickyRows(f, this.screenHistory, chrome, this.scrollTop);
    this.selection.paint(screen, this.screenHistory);
    if (this.scrollTop !== null) this.scrollTop = screen.start;
    return screen;
  }

  /** Only a resize of the same conversation can reuse its scroll anchor. */
  private anchorScroll(owner: typeof this.screenOwner, cols: number): void {
    if (owner !== this.screenOwner) this.scrollTop = null;
    if (this.scrollTop === null) { this.scrollAnchor = undefined; return; }
    if (!this.screen || this.screen.cols === cols) return;
    const lines = this.page ? this.shown(this.page) : this.looseLines;
    this.scrollAnchor ??= captureAnchor(lines, this.screen.cols, this.scrollTop);
    this.scrollTop = resolveAnchor(lines, cols, this.scrollAnchor);
  }

  /** The last drawing error said, so a frame that keeps failing is reported once. */
  private drawError = "";

  /** After restoring the primary screen, print the active history and any partial reply. */
  private leave(): void {
    const page = this.page;
    const held = page && !page.view ? page.md.pending : "";
    const history = page ? this.shown(page) : this.looseLines;
    const lines = [...(page ? this.header(page, false) : []), ...historyRows(history, this.deps.term.cols), ...(held ? held.split("\n") : [])];
    this.pending = [];
    this.deps.term.write(`\x1b[0m${commit(lines, this.deps.term.cols)}\x1b[?25h`);
  }

  // --- pages ------------------------------------------------------------------

  /** Read-only reconciliation. Coalesce bursts, but a request arriving during a
   * snapshot gets one trailing pass. Submission and turn ownership are separate. */
  refreshSessions(force = true): Promise<void> {
    if (force) this.clipboardGeneration++;
    this.refreshAgain = true;
    this.refreshForce ||= force;
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.resolve().then(async () => {
      do {
        this.refreshAgain = false;
        const forced = this.refreshForce;
        this.refreshForce = false;
        await Promise.all([
          ...this.pages.map(page => this.refreshPage(page, forced)),
          this.refreshReviewRounds().catch(err => this.say(dim(`review rounds refresh failed: ${err}`))),
          this.refreshDynamicDispatch().catch(err => this.say(dim(`dynamic dispatch refresh failed: ${err}`))),
        ]);
        await this.refreshProjects().catch(err => this.say(dim(`refresh projects failed: ${err}`)));
        await this.refreshTaskInbox();
      } while (this.refreshAgain && !this.closed);
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private validPage(page: Page): boolean {
    return !this.closed && !page.deleting && this.pages.includes(page);
  }

  private async refreshPage(page: Page, forced: boolean): Promise<void> {
    if (!this.validPage(page)) return;
    const nameBefore = page.name, remoteBefore = page.remote;
    const safe = [this.refreshHeader(page), forced ? this.questions.refresh(page) : Promise.resolve(),
      displayName(page.project).then(name => { if (this.validPage(page) && page.name === nameBefore) page.name = name; }),
      remoteOf(page.project).then(remote => { if (this.validPage(page) && page.remote === remoteBefore) page.remote = remote; })];
    this.checkLive(page.project);
    const results = await Promise.allSettled(safe);
    try {
      if (page.busy) this.deferredRefresh.add(page);
      else if (await page.orch.refresh?.() === false || page.busy) this.deferredRefresh.add(page);
      else if (this.validPage(page)) {
        this.deferredRefresh.delete(page);
        this.syncTranscript(page);
        await this.recoverImages(page);
      }
      // Don't overwrite a history append/recall that raced the read.
      const before = page.inputHistory, writing = page.savingHistory;
      await writing;
      const saved = await loadHistory(page.project);
      if (this.validPage(page) && page.inputHistory === before && page.savingHistory === writing && this.historyAt === -1) {
        page.inputHistory = [...saved.entries, ...before.filter(text => !saved.entries.includes(text))].slice(-MAX_INPUT_HISTORY);
        page.historyLines = saved.lines;
      }
      const failed = results.find(r => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      if (this.validPage(page)) this.say(dim(`refresh failed (input retained): ${error instanceof Error ? error.message : String(error)}`), page);
    }
    this.draw();
  }

  /** Only durable exact IDs acknowledge pending input. Re-rendering saved tool
   * entries is presentation, never tool execution. Called idle, pre-stream, or
   * mid-turn by a daemon client when an entry lands: the durable entries then
   * supersede what the live events showed, so the stream's partial text and
   * running calls are dropped with the old rendering (the events still ahead of
   * the record follow again through the same hooks). */
  private syncTranscript(page: Page): void {
    const consumed = page.orch.consumed?.();
    if (consumed) page.sent = page.sent.filter(m => !consumed.has(m.inputId));
    const entries = page.orch.entries?.();
    if (!entries) return;
    const head = entries.at(-1)?.uuid;
    if (this.renderedHeads.get(page) === head) return;
    page.md.reset(); page.calls.clear(); page.held.length = 0;
    const lines = this.restored(page, entries, page.busy, id => page.questions.seen.get(id));
    // Keep local diagnostics/skip feedback, but don't duplicate persisted answers.
    const saved = new Set(lines.map(line => JSON.stringify(line)));
    const notes = (this.notices.get(page) ?? []).filter(line => !saved.has(JSON.stringify(line)));
    this.notices.set(page, notes);
    const anchor = this.relocatedAnchor(page, lines);
    page.lines = [...lines, ...notes];
    if (anchor) { this.scrollAnchor = anchor; this.scrollTop = resolveAnchor(this.shown(page), this.deps.term.cols, anchor); }
    this.renderedHeads.set(page, head);
    if (page === this.page && !page.view) this.reprint();
  }

  /** Where the scrolled-up viewport's anchor line sits in the re-rendered `lines` (the same shown line's same occurrence), if the page is scrolled. */
  private relocatedAnchor(page: Page, lines: Line[]): HistoryAnchor | undefined {
    if (page !== this.page || page.view || this.scrollTop === null) return;
    const old = this.shown(page, page.lines), next = this.shown(page, lines);
    const anchor = captureAnchor(old, this.deps.term.cols, this.scrollTop);
    const source = JSON.stringify(old[anchor.line]);
    const occurrence = old.slice(0, anchor.line).filter(line => JSON.stringify(line) === source).length;
    const matches = next.flatMap((line, i) => JSON.stringify(line) === source ? [i] : []);
    anchor.line = matches[occurrence] ?? Math.min(anchor.line, next.length);
    return anchor;
  }

  /** The record as lines. While the turn runs (`running`), the newest entry's calls without a result are left out: the live view shows them running, and the record says how they ended once it does. */
  private restored(page: Page, entries: Entry[], running: boolean, asked: import("./restore").AskedLookup): Line[] {
    const omit = running ? unresolvedCalls(entries) : undefined;
    if (omit?.size) this.hidRunning.add(page); else this.hidRunning.delete(page);
    return restore(entries, this.deps.term.cols, Infinity, asked, omit);
  }

  private restorePage(page: Page, asked: import("./restore").AskedLookup, running: boolean): void {
    const entries = page.orch.entries?.() ?? [];
    // All saved conversation must be scrollable before exit, including originals
    // before model compaction. Cache rendered rows in viewport(); only the visible
    // slice is drawn on keys/ticks, rather than capping access to older messages.
    page.lines = [...this.restored(page, entries, running, asked), ...page.lines];
  }

  async openPage(project: string, url?: string): Promise<Page> {
    this.clipboardGeneration++;
    this.modelGeneration++;
    const existing = this.pages.findIndex((p) => p.project === project);
    if (existing !== -1) {
      if (existing !== this.active) { this.active = existing; this.reprint(); }
      return this.pages[existing]!;
    }
    const page: Page = { project, name: project, orch: null as unknown as Orchestrator, remote: "", lines: [], md: new MarkdownStream(), busy: false, busySince: 0, streamed: false, inputHistory: [], historyLines: 0, savingHistory: Promise.resolve(), sent: [], questions: pageQuestions(), held: [], view: null, calls: new Calls() };
    const tools: ToolEvents = { onRefresh: () => { this.syncTranscript(page); this.refreshedTurns.add(page); }, onTool: (call) => this.toolStarted(page, call), onToolResult: (outcome) => this.toPage(page, [page.calls.finish(outcome)]), notice: text => this.say(dim(text), page) };
    page.orch = await this.deps.openOrchestrator(project, url, (text, plain) => this.stream(page, text, plain), (msgs) => this.inbox(page, msgs), tools);
    // Like `claude --continue`: the page starts with what its transcript showed live (from the transcript the orchestrator loaded), and ↑ recalls what was typed.
    const asked = await this.questions.load(page);
    // A turn already running elsewhere (the daemon's) shows its unfinished calls live, not as interrupted.
    this.restorePage(page, asked, await page.orch.pending().catch(() => false));
    this.renderedHeads.set(page, page.orch.entries?.().at(-1)?.uuid);
    const saved = await loadHistory(project);
    page.inputHistory = saved.entries;
    page.historyLines = saved.lines;
    page.remote = await remoteOf(project);
    page.name = await displayName(project);
    this.notices.set(page, [...this.looseLines]);
    page.lines.unshift(...this.looseLines);
    this.looseLines = [];
    if (this.looseNote !== undefined) { this.notes.set(page, this.looseNote); this.looseNote = undefined; }
    page.model = await this.readModel(project);
    page.settings = await effectiveSettings(project, page.model).catch(() => undefined);
    try { page.sent.push(...(await pendingImageInputs(project, page.orch.consumed?.())).map(input => ({ ...input, retry: true }))); }
    catch (error) { this.say(dim(`image recovery failed: ${error}`), page); }
    await this.refreshReviewRounds().catch(err => this.say(dim(`review rounds refresh failed: ${err}`), page));
    await this.refreshDynamicDispatch().catch(err => this.say(dim(`dynamic dispatch refresh failed: ${err}`), page));
    this.pages.push(page);
    this.active = this.pages.length - 1;
    void this.keepDaemon(project, page); // the daemon starts in the background; the page shows what happened
    this.checkLive(project);
    this.questions.poll([page]);
    this.reprint();
    if (this.projectList) await this.refreshProjects();
    return page;
  }

  closePage(index = this.active): void {
    this.clipboardGeneration++;
    this.taskInbox = null;
    this.cancelClear();
    this.helpTop = null;
    this.modelGeneration++;
    const page = this.pages[index];
    if (!page) return;
    this.questions.hide(page);
    page.view?.leave();
    page.orch.dispose?.();
    this.pages.splice(index, 1);
    if (index < this.active) this.active--;
    this.active = Math.min(this.active, Math.max(0, this.pages.length - 1));
    this.reprint();
  }

  switchPage(delta: number): void {
    this.clipboardGeneration++;
    if (this.pages.length < 2) return;
    this.active = (this.active + delta + this.pages.length) % this.pages.length;
    this.reprint();
  }

  /** Every project id, open or on disk, with the name it shows, so no two pages read the same. */
  private async shownNames(): Promise<Map<string, string>> {
    const shown = new Map<string, string>(this.pages.map((p) => [p.project, p.name]));
    for (const id of await listProjects()) if (!shown.has(id)) shown.set(id, await displayName(id));
    return shown;
  }

  /** Start a conversation in the given local directory, else the original launch checkout. */
  async newPage(name?: string, url?: string): Promise<void> {
    const shown = await this.shownNames();
    if (name && [...shown].some(([id, n]) => id !== name && n === name)) return this.say(dim(`another project is already called ${name}`));
    const project = name ?? newProjectName([...shown.keys(), ...shown.values()]);
    try {
      const page = await this.openPage(project, url ?? this.deps.source ?? undefined);
      if (!name) this.note("/rename <name> to rename", page);
    } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Set the page's display name; the project folder, id and running agents are untouched, so this works mid-turn. */
  async renamePage(to: string): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (!to) return this.say(dim("usage: /rename <name>"));
    if (this.pages.some((p) => p !== page && (p.name === to.trim() || p.project === to.trim()))) return this.say(dim(`another page is already called ${to.trim()}`));
    try {
      const from = page.name;
      page.name = await setDisplayName(page.project, to);
      this.note(`${from} → ${page.name}`, page);
      if (this.projectList) await this.refreshProjects();
    } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`, page); }
  }

  // --- project list -----------------------------------------------------------

  /** Ctrl+B: open the project list, or close it. */
  toggleProjects(): Promise<void> | void {
    return this.projectList ? this.closeProjects() : this.openProjects();
  }

  async openProjects(): Promise<void> {
    this.taskInbox = null;
    this.cancelClear();
    this.modelGeneration++;
    const items = await orderedProjects();
    const index = Math.max(0, items.findIndex((it) => it.name === this.page?.project));
    this.helpTop = null;
    this.menu = null;
    this.projectList = { items, index, status: "", confirm: null };
    this.draw();
  }

  closeProjects(): void {
    this.projectList = null;
    this.draw();
  }

  /** Reload the project list, keeping the selection on `select` (or the selected name) when it is still there. */
  private async refreshProjects(select = this.projectList?.items[this.projectList.index]?.name): Promise<void> {
    const list = this.projectList;
    if (!list) return;
    const index = list.index;
    const items = await orderedProjects();
    if (this.projectList !== list) return;
    if (list.index !== index) select = list.items[list.index]?.name;
    list.items = items;
    const at = items.findIndex((it) => it.name === select);
    list.index = at !== -1 ? at : Math.min(list.index, Math.max(0, items.length - 1));
    this.draw();
  }

  /** What each key does in the project list, given the selected project. Actions use its id; messages its label. */
  private readonly projectActions = new Map<string, (entry: ProjectEntry) => Promise<void> | void>([
    ["up", () => this.moveProjects(-1)], ["k", () => this.moveProjects(-1)],
    ["down", () => this.moveProjects(1)], ["j", () => this.moveProjects(1)],
    ["enter", (entry) => this.openFromProjects(entry.name)],
    ["p", (entry) => this.pinFromProjects(entry)],
    ["d", (entry) => { this.projectList!.confirm = entry; this.projectList!.status = bold(`delete ${entry.label}? y/n`); }],
  ]);

  /** Ctrl+B anywhere, and every key while the project list is open (and no menu is up). */
  private projectsTake(k: Key): boolean {
    return (k.ctrl === true && k.name === "b") || (!!this.projectList && !this.menu);
  }

  /** Keys while the project list is open, and Ctrl+B anywhere. */
  private async projectsKey(k: Key): Promise<void> {
    if (k.ctrl && k.name === "b") return this.toggleProjects();
    const list = this.projectList!;
    if (list.confirm) return this.confirmDelete(k);
    list.status = "";
    const id = listKeyId(k);
    if (id === "escape") return this.closeProjects();
    const entry = list.items[list.index];
    const action = id === null ? undefined : this.projectActions.get(id);
    if (action && entry) await action(entry);
    this.draw();
  }

  private moveProjects(delta: number): void {
    const list = this.projectList!;
    list.index = (list.index + delta + list.items.length) % list.items.length;
  }

  private async openFromProjects(name: string): Promise<void> {
    this.projectList = null;
    try { await this.openPage(name); } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private async pinFromProjects(entry: ProjectEntry): Promise<void> {
    const on = await togglePin(entry.name);
    await this.refreshProjects(entry.name);
    if (this.projectList) this.projectList.status = dim(`${on ? "pinned" : "unpinned"} ${entry.label}`);
  }

  /** The key after "delete x? y/n": only a plain y or Y deletes, anything else cancels. */
  private async confirmDelete(k: Key): Promise<void> {
    const list = this.projectList!;
    const target = list.confirm!;
    list.confirm = null;
    list.status = "";
    if (k.name === "char" && !k.ctrl && !k.alt && (k.text === "y" || k.text === "Y")) await this.deleteFromProjects(target);
    this.draw();
  }

  /**
   * Delete a project (by id) after its y/n. Its page is marked so no turn
   * starts while the checks run, and closes only if it is still idle once they pass.
   */
  private async deleteFromProjects({ name, label }: ProjectEntry): Promise<void> {
    const list = this.projectList!;
    const page = this.pages.find((p) => p.project === name);
    const midTurn = `${label} is mid-turn; try again when it ends`;
    if (page?.busy) { list.status = dim(midTurn); return; }
    if (page) page.deleting = true;
    let status: string;
    try {
      await deleteProject(name, {
        ...this.deps.projects,
        beforeRemove: () => {
          if (!page) return;
          if (page.busy) throw new Error(midTurn);
          const at = this.pages.indexOf(page);
          if (at !== -1) this.closePage(at);
        },
      });
      status = `deleted ${label}`;
    } catch (err) {
      if (page) page.deleting = false;
      status = err instanceof Error ? err.message : String(err);
    }
    // The status goes up once the list shows the result, as for a pin.
    await this.refreshProjects();
    if (this.projectList) this.projectList.status = dim(status);
  }

  private async runTurn(page: Page): Promise<void> {
    if (page.busy || !this.validPage(page)) return;
    this.refreshedTurns.delete(page);
    page.busy = true;
    page.busySince = this.clock.now();
    page.streamed = false;
    this.draw();
    let failed = false;
    try {
      for (const reply of await page.orch.turn()) {
        this.endPartial(page);
        this.toPage(page, [replyLine(reply.from, reply.text)]);
      }
    } catch (err) {
      failed = true;
      this.endPartial(page);
      this.say(`${bold("error")} ${err instanceof Error ? err.message : String(err)}; turn stopped. send another message to resume with retained history; changing model alone does not retry. exited agents require restart.`, page);
    } finally { this.endTurn(page, failed); }
  }

  /** A failed turn's lines that the record does not hold stay on the page as notices. */
  private keepUnsaved(page: Page): void {
    const saved = restore(page.orch.entries?.() ?? [], this.deps.term.cols, Infinity, id => page.questions.seen.get(id));
    const known = new Set([...saved, ...(this.notices.get(page) ?? [])].map(line => JSON.stringify(line)));
    for (const line of page.lines) if (!known.has(JSON.stringify(line))) this.keepNotice(page, line);
  }

  /** The turn is over: settle what it showed, keep a failed turn's lines as notices, and show the record's view of what it left running. */
  private endTurn(page: Page, failed: boolean): void {
    this.endPartial(page);
    page.busy = false;
    // Only a turn that rendered its initial shared snapshot can claim its
    // subsequent streamed head. Losing turn ownership renders nothing.
    if (this.refreshedTurns.delete(page)) this.renderedHeads.set(page, page.orch.entries?.().at(-1)?.uuid);
    this.toPage(page, page.calls.interrupt());
    if (failed) this.keepUnsaved(page);
    // Calls left out as running get their marker from the record now that nothing runs (interrupted, or how they ended).
    if (this.hidRunning.delete(page)) { this.renderedHeads.delete(page); this.syncTranscript(page); }
    if (this.deferredRefresh.has(page) || page.sent.length) void this.refreshSessions();
    this.draw();
  }

  // --- menus ------------------------------------------------------------------

  openMenu<T>(title: string, choices: Choice<T>[], pick: (value: T) => Promise<void> | void, modelOperation?: number): void {
    this.beginMenu(modelOperation);
    if (!choices.length) return;
    this.showMenu({
      title: dim(title) + dim("   ↑↓ enter   esc cancels"),
      items: choices.map((c) => `${c.current ? "●" : " "} ${c.label}`),
      index: Math.max(0, choices.findIndex((c) => c.current)),
      pick: (i) => pick(choices[i]!.value),
    });
  }

  /** The open menu as drawn now: the /agents rows are rebuilt for the current time. */
  private menuView(): Menu | null {
    const m = this.menu;
    return m?.itemsAt ? { ...m, items: m.itemsAt(this.clock.now()) } : m;
  }

  /** What opening any menu first closes or invalidates. */
  private beginMenu(modelOperation?: number): void {
    this.clipboardGeneration++;
    this.taskInbox = null;
    this.cancelClear();
    if (modelOperation === undefined) this.modelGeneration++;
  }

  private showMenu(menu: ActiveMenu): void {
    this.helpTop = null;
    this.menu = menu;
    this.draw();
  }

  private async agentsMenu(page: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    const view = page.view;
    const current = () => operation === this.modelGeneration && page === this.page && this.pages.includes(page) && !page.deleting && page.view === view;
    const list = this.deps.agents ?? listAgents;
    let agents = await list(page.project);
    if (!current()) return;
    if (!agents.length) return this.say(dim("no agents yet"));
    const rowsAt = (now: number) => agents.map((a) => agentRow(a, now));
    this.beginMenu(operation);
    const menu: ActiveMenu = {
      title: dim("attach to an agent") + dim("   ↑↓ enter   esc cancels"),
      items: rowsAt(this.clock.now()),
      index: 0,
      itemsAt: rowsAt,
      pick: (i) => {
        const agent = agents[i];
        if (!agent || !current()) return;
        page.view?.leave();
        return this.attach(page, agent.name, agent.live);
      },
      reload: async () => {
        const next = await list(page.project);
        if (this.menu !== menu) return;
        if (!current()) { this.menu = null; return this.draw(); } // the view or model operation moved on: close, don't tick a stale list
        if (!next.length) return;
        menu.index = reselect(menu.index, agents, next);
        agents = next;
        menu.items = rowsAt(this.clock.now());
      },
    };
    this.showMenu(menu);
  }

  private async accountsMenu(): Promise<void> {
    this.modelGeneration++;
    this.openMenu("accounts: enter uses one or signs it in", await accountChoices(dim), async (account) => {
      if (account.ok) return this.note(await useAccount(account));
      await this.login(`${account.provider} ${account.id.split(":")[1]}`);
    });
  }

  private async modelMenu(page: Page, operation: number, identity: string): Promise<void> {
    this.note("fetching models…", page);
    const { choices, errors } = await (this.deps.modelChoices ?? modelChoices)(dim, page.project);
    if (this.notes.delete(page)) this.draw();
    if (!this.modelPageCurrent(page, operation)) return;
    for (const e of errors) this.say(dim(e));
    if (!choices.length) return this.say(dim("no models available; sign in with /login first"));
    this.openMenu("switch model   (/model <id> for any other id)", choices, async (id) => this.switchModel(page, id, operation, identity), operation);
  }

  private async attach(page: Page, name: string, live: boolean): Promise<void> {
    this.cancelClear();
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r, live, calls: new Calls() }));
    const view = page.view!;
    if (page === this.page) this.reprint();
    this.say(dim("esc or /back returns"), page);
    await follow(paths.transcript(page.project, name), (_s, entry) => this.toView(page, view, view.calls.absorb(parts(entry) ?? [])), stopped, 300, () => { if (!view.live) this.toView(page, view, view.calls.interrupt()); });
    if (page.view === view) {
      page.view = null;
      if (page === this.page) this.reprint();
    }
    this.draw();
  }

  /** The injected per-poll watchers for every open page, then the task inbox (so rows archived by the daemon's watchers disappear without another interval); each page's daemon is kept alive. */
  private watchPages(): void {
    const watchers = [this.deps.watchdog, this.deps.merges].filter((w): w is NonNullable<typeof w> => !!w);
    void this.refreshTaskInbox();
    for (const p of this.pages) {
      void this.keepDaemon(p.project, p);
      void Promise.all(watchers.map(w => w(p.project).catch(() => {}))).then(() => this.refreshTaskInbox(p));
    }
  }

  /** Start the project's orchestrator daemon when none is alive: what it did (a transient note), or why it could not (a line on the page). */
  private async ensureDaemon(project: string): Promise<{ line: string; failed: boolean } | undefined> {
    if (!this.deps.ensureDaemon) return;
    try { const line = await this.deps.ensureDaemon(project); return line ? { line, failed: false } : undefined; }
    catch (error) { return { line: `orchestrator is not running: ${error instanceof Error ? error.message : String(error)}`, failed: true }; }
  }
  /** A repeated failure (a start that keeps failing) is shown once, not once per poll; every (rate-limited) start or restart is noted. */
  private readonly daemonLines = new WeakMap<Page, string>();
  private async keepDaemon(project: string, page: Page): Promise<void> {
    const outcome = await this.ensureDaemon(project);
    if (!outcome || !this.validPage(page)) return;
    if (!outcome.failed) { this.daemonLines.delete(page); return this.note(outcome.line, page); }
    if (this.daemonLines.get(page) === outcome.line) return;
    this.daemonLines.set(page, outcome.line);
    this.say(dim(outcome.line), page);
  }

  /** Start a turn on every idle page whose orchestrator has unread messages. */
  private runPending(): void {
    for (const p of this.pages) if (!p.busy && !p.deleting) p.orch.pending().then((has) => { if (has) this.runTurn(p); }).catch(() => {});
  }

  private async login(arg: string): Promise<void> {
    if (this.loggingIn) return this.say(dim("already signing in; /quit cancels"));
    this.loggingIn = true;
    this.say(dim("signing in… (/quit cancels)"));
    let ok = false;
    try {
      const result = await (this.deps.login ?? login)(arg, { write: (s) => this.say(s.replace(/\n$/, "")), signal: this.loginAbort.signal });
      ok = !result.startsWith("usage:");
      this.say(result);
    } catch (err) { this.say(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { this.loggingIn = false; }
    // Text typed meanwhile was held back: send it now, or drop it when sign-in failed.
    await this.drainLogin(ok);
    this.draw();
    this.runPending();
  }

  /** Each queued message stays owned until its send attempt ends. A failure is reported by send; later messages are still attempted. */
  private async drainLogin(ok: boolean): Promise<void> {
    for (const [page, texts] of [...this.queued]) await this.drainLoginPage(page, texts, ok);
  }

  private async drainLoginPage(page: Page, texts: { text: string; submission?: string; inputId: string; attachments?: ImageRef[] }[], ok: boolean): Promise<void> {
    if (!ok) this.say(dim(texts.some(m => m.attachments?.length) ? "sign-in failed; image prompts retained for /retry-images" : `sign-in failed; dropped ${texts.length} queued message(s)`), page);
    while (texts.length) {
      const { text, submission, inputId, attachments } = texts.shift()!; // ownership transfers to send (Page.sent), or an explicit drop report
      if (ok && this.pages.includes(page)) await this.send(page, text, submission, inputId, attachments).catch(() => {});
      else {
        if (attachments?.length) page.sent.push({ text, submission, inputId, attachments, retry: true });
        this.say(dim(`not sent after sign-in (${page.name}): ${text}${imageLabels(attachments)}${attachments?.length ? "; /retry-images" : ""}`), this.pages.includes(page) ? page : this.page);
      }
    }
    if (!texts.length && this.queued.get(page) === texts) this.queued.delete(page);
  }

  // --- input ------------------------------------------------------------------

  /**
   * The slash commands, by name. Every one works at any time: mid-turn, while
   * viewing an agent and while signing in (a second /login is refused by
   * login() itself). Table order is the order within a /help group.
   */
  readonly commands: ReadonlyMap<string, Command> = new Map<string, Command>([
    ["/refresh", { run: () => this.refreshSessions(), help: { group: "conversation", label: "/refresh", description: "reload shared local state; active context waits until idle; never runs work" } }],
    ["/projects", { run: () => this.openProjects(), help: { group: "projects", label: "/projects", description: "browse projects: enter opens, p pins, d deletes" } }],
    ["/retry-images", { run: (_, page) => this.retryImages(page), help: { group: "conversation", label: "/retry-images", description: "retry unconfirmed image prompts by original id; never replay consumed input" } }],
    ["/keys", { run: () => { this.keyEcho = true; this.say(dim("press keys; esc ends")); }, help: { group: "advanced", label: "/keys", description: "diagnose keys/wheel; ctrl+g keeps draft; esc ends" } }],
    ["/rename", { args: true, run: (args) => this.renamePage(args), help: { group: "projects", label: "/rename <name>", description: "change display name only; project id stays fixed" } }],
    ["/new", { args: true, run: (args) => this.newCommand(args), help: { group: "projects", label: "/new [name] [directory]", description: "create a project page" } }],
    ["/close", { run: () => this.closePage(), help: { group: "projects", label: "/close", description: "close this page; keep its project and history" } }],
    ["/quit", { run: () => this.quit(), help: { group: "projects", label: "/quit", description: "exit; keep conversation history" } }],
    ["/inbox", { run: (_, page) => this.toggleTaskInbox(page), help: { group: "conversation", label: "/inbox", description: "user inbox: tasks / questions; shift+tab switches sections, esc/tab closes" } }],
    ["/agents", { needsPage: true, run: (_, page) => this.agentsMenu(page!), help: { group: "conversation", label: "/agents", description: "browse and follow agent conversations" } }],
    ["/effort", { args: true, run: (args, page) => args ? this.requestSetting(page, args, effortCommand) : this.effortMenu(page), help: { group: "settings", label: "/effort [level|default]", description: "choose or set project/model reasoning effort" } }],
    ["/fast", { args: true, run: (args, page) => this.requestSetting(page, args, fastCommand), help: { group: "settings", label: "/fast [on|off]", description: "show or set project/model fast mode" } }],
    ["/clear", { run: (_, page) => this.clearCommand(page), help: { group: "conversation", label: "/clear", description: "clear model context after confirmation; keep full history" } }],
    ["/compact", { needsPage: true, run: async (_, page) => { await page!.orch.compact?.(); }, help: { group: "advanced", label: "/compact", description: "summarize model context; keep full history" } }],
    ["/model", { args: true, run: (args, page) => this.modelCommand(args, page), help: { group: "settings", label: "/model [id]", description: "choose or set the project model" } }],
    ["/accounts", { run: () => this.accountsMenu(), help: { group: "settings", label: "/accounts", description: "choose a subscription account" } }],
    ["/login", { args: true, run: (args) => this.login(args), help: { group: "settings", label: "/login claude|codex [profile]", description: "sign in to a subscription account" } }],
    ["/review-rounds", { args: true, run: (args, page) => this.reviewRoundsCommand(args, page), help: { group: "advanced", label: "/review-rounds [n]", description: "review rounds before ci; 0 goes straight to ci" } }],
    ["/dynamic-dispatch", { args: true, run: (args, page) => this.dynamicDispatchCommand(args, page), help: { group: "settings", label: "/dynamic-dispatch [on|off]", description: "show or set dynamic dispatch (global)" } }],
    ["/questions", { run: (_, page) => this.questions.command(page), help: { group: "conversation", label: "/questions", description: "inbox questions (ctrl+q); enter answers or picks skip; shift+tab tasks" } }],
    ["/back", { run: (_, page) => (page?.view ? page.view.leave() : this.say(dim("not viewing an agent"))), help: { group: "conversation", label: "/back", description: "return from agent view (also esc)", viewOnly: true } }],
    ["/help", { run: () => this.toggleHelp(), help: { group: "conversation", label: "/help", description: "commands and keyboard shortcuts; esc closes" } }],
  ]);

  /** Clear is a local modal, never a prompt or a scheduled model turn. */
  private async clearCommand(page?: Page): Promise<void> {
    this.cancelClear();
    if (!page) return this.say(dim("open a project before clearing context"));
    let operation: ClearConfirmation | undefined;
    try {
      this.checkClearPage(page);
      operation = { page, identity: projectIdentity(page.project), controller: new AbortController() };
      this.clearing = operation;
      await page.orch.checkClear!();
      if (!this.clearCurrent(operation)) return;
      this.checkClearPage(page);
      this.helpTop = null;
      this.taskInbox = null;
      this.projectList = null;
      this.menu = operation.menu = {
        title: dim(`clear model context for ${page.name}? history/files/agents stay. ↑↓ enter · esc`),
        items: ["cancel", "clear context"], index: 0,
        pick: index => { if (index === 1) return this.confirmClear(operation!); this.cancelClear(); this.draw(); },
      };
      this.draw();
    } catch (error) {
      if (!operation || this.clearCurrent(operation)) {
        this.cancelClear();
        this.say(dim(`cannot clear: ${error instanceof Error ? error.message : error}`), page);
      }
    }
  }

  private checkClearPage(page: Page): void {
    if (!this.pages.includes(page) || page !== this.page || page.deleting) throw new Error("project changed; try again");
    if (page.view) throw new Error(`viewing ${page.view.name}; /back first to clear the orchestrator`);
    if (page.busy) throw new Error("orchestrator is running or compacting; wait before clearing context");
    if (page.sent.length || this.queued.get(page)?.length || page.questions.closing) throw new Error("input is pending; context was not cleared");
    if (!page.orch.checkClear || !page.orch.clear) throw new Error("this session does not support clearing context");
  }

  private clearCurrent(operation: ClearConfirmation): boolean {
    return this.clearing === operation && !operation.controller.signal.aborted && !this.closed
      && this.page === operation.page && this.pages.includes(operation.page);
  }

  private cancelClear(): void {
    const operation = this.clearing;
    if (!operation) return;
    operation.controller.abort(new Error("clear cancelled"));
    if (this.menu === operation.menu) this.menu = null;
    this.clearing = undefined;
  }

  private async confirmClear(operation: ClearConfirmation): Promise<void> {
    if (!this.clearCurrent(operation) || operation.committing) return;
    operation.committing = true;
    const page = operation.page;
    try {
      this.checkClearPage(page);
      if (projectIdentity(page.project) !== operation.identity) throw new Error("project changed; reopen it before clearing context");
      // Backend rechecks inside its publication lock and blocks overlapping turns.
      await page.orch.clear!(operation.controller.signal);
      this.say(dim("model context cleared. saved history, files and agents are unchanged."), page);
    } catch (error) {
      if (this.clearCurrent(operation)) this.say(dim(`cannot clear: ${error instanceof Error ? error.message : error}`), page);
    } finally {
      if (this.clearing === operation) this.cancelClear();
      this.draw();
    }
  }

  /** Own all typing/paste/question keys, even when a tiny footer hides the modal.
   * Navigation cancels first; Enter only confirms after an explicit plain arrow selection. */
  private clearKey(k: Key): Promise<void> | void {
    if (k.name === "escape" || k.ctrl && k.name === "c") { this.cancelClear(); return this.draw(); }
    if (k.ctrl && ["n", "z", "x", "b"].includes(k.name)) { this.cancelClear(); return this.onKey(k); }
    const operation = this.clearing!;
    if (operation.committing || !operation.menu || k.ctrl || k.alt || k.shift) return;
    const menu = operation.menu;
    if (k.name === "up" || k.name === "down") menu.index = 1 - menu.index;
    if (k.name === "enter") {
      if (menu.index === 1) return this.confirmClear(operation);
      this.cancelClear();
    }
    this.draw();
  }

  /** /new [name] [directory]: the name must be a valid project id. */
  private newCommand(args: string): Promise<void> | void {
    const [, name, directory] = args.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/) ?? [];
    if (name && !validProjectName(name)) return this.say(dim("project ids are letters, digits, . _ or -; /rename sets a free-form name"));
    return this.newPage(name, directory);
  }

  private async requestSetting(page: Page | undefined, args: string, command: typeof effortCommand): Promise<void> {
    if (!page) return this.say(dim("open a project before changing its model settings"));
    this.note(await command(page.project, args), page);
    await this.refreshHeader(page);
  }

  /** /effort opens the picker for the project's current model; it saves for exactly that model. */
  private async effortMenu(page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.say(dim("open a project before changing its model settings"));
    const identity = projectIdentity(page.project);
    this.say(dim("fetching effort levels…"));
    let picker: Awaited<ReturnType<typeof effortChoices>>;
    try { picker = await (this.deps.effortChoices ?? effortChoices)(page.project); }
    catch (err) { return this.say(dim(err instanceof Error ? err.message : String(err)), page); }
    if (!this.modelPageCurrent(page, operation)) return;
    if (picker.note) this.say(dim(picker.note), page);
    this.openMenu(`effort for ${picker.model}   (/effort <level|default> sets directly)`, picker.choices, async (level) => {
      if (!this.modelPageCurrent(page, operation)) return;
      try { this.say(dim(await setEffort(page.project, picker.model, level, identity)), page); }
      catch (err) { return this.say(dim(err instanceof Error ? err.message : String(err)), page); }
      await this.refreshHeader(page);
    }, operation);
  }

  /** /model opens the menu; /model <id> sets any id. */
  private async modelCommand(id: string, page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.say(dim("open a project before changing its model"));
    const identity = projectIdentity(page.project);
    if (!id) return this.modelMenu(page, operation, identity);
    await this.switchModel(page, id, operation, identity);
  }

  private modelPageCurrent(page: Page, operation: number): boolean {
    return operation === this.modelGeneration && this.page === page && this.pages.includes(page) && !page.deleting;
  }

  private async modelAgents(project: string): Promise<string[] | null> {
    try { return await (this.deps.modelAgents ?? liveAgentsOrNull)(project); }
    catch { return null; }
  }

  private async switchModel(page: Page, id: string, operation: number, identity: string): Promise<void> {
    validateModel(id);
    if (!this.modelPageCurrent(page, operation)) return;
    const agents = await this.modelAgents(page.project);
    if (!this.modelPageCurrent(page, operation)) return;
    if (agents === null) return this.say(dim("could not determine running agents; try again"), page);
    const workers = agents.filter((name) => name.startsWith("worker-")).length;
    const reviewers = agents.filter((name) => name.startsWith("reviewer-")).length;
    const save = () => this.commitModel(page, id, operation, identity);
    if (!workers && !reviewers) return save();
    this.openMenu(`switch this project to ${id}? applies to orchestrator, ${workers} workers and ${reviewers} reviewers. running tools finish; agents switch before their next model request.`, [
      { value: false, label: "cancel", current: true },
      { value: true, label: "switch all" },
    ], async (confirmed) => { if (confirmed) await save(); }, operation);
  }

  private async commitModel(page: Page, id: string, operation: number, identity: string): Promise<void> {
    if (!this.modelPageCurrent(page, operation)) return;
    // Persistence boundary: once invoked, this commit belongs to the captured
    // project even if its page closes or selection changes. Disk identity and
    // the shared project-state lock protect deletion/recreation, not selection.
    const result = await (this.deps.saveModel ?? setModel)(id, page.project, identity);
    this.note(result, page);
    await this.refreshHeader(page);
    // The daemon reads the saved model at its next request; its acknowledgement replaces the note when it arrives.
    void page.orch.observeModel?.(id).then(ack => this.note(`orchestrator: ${ack}`, page), error => this.say(dim(`orchestrator did not acknowledge the model: ${error instanceof Error ? error.message : String(error)}`), page));
  }

  /**
   * A sent line, guarded in this order:
   * 1. a known command that needs no page runs at once (agent view, sign-in, no page: all fine);
   * 2. with no page open, anything else (/agents, an unknown command, plain text) opens a fresh orch-xxxx and is dropped;
   * 3. a known command runs on the page;
   * 4. an unknown one (or arguments to a command that takes none) says "unknown command /x";
   * 5. plain text goes to the orchestrator (talk), refused in an agent view and queued while signing in.
   */
  private async submit(text: string, attachments: ImageRef[] = []): Promise<void> {
    this.clipboardGeneration++;
    this.cancelClear();
    const call = parseCommand(text, this.commands);
    if (call && call.name !== "/model") this.modelGeneration++;
    if (call?.command && !call.command.needsPage) return call.command.run(call.args, this.page);
    const page = this.page;
    if (!page) return this.newPage();
    if (call?.command) return call.command.run(call.args, page);
    if (call) return this.say(dim(`unknown command ${call.name}`));
    return this.talk(page, text, attachments);
  }

  /** Plain text for the page's orchestrator: refused while viewing an agent, held while signing in. */
  private async talk(page: Page, text: string, attachments: ImageRef[] = []): Promise<void> {
    if (page.view) return this.say(dim(`viewing ${page.view.name}; /back first to talk to the orchestrator`));
    const submission = page.orch.submission?.();
    const inputId = crypto.randomUUID();
    // While signing in the text waits in the app; login() sends it only if sign-in succeeds.
    if (this.loggingIn || this.queued.has(page)) {
      // Append to the same owner while login is draining too, so a new submit
      // cannot overtake older held input during an asynchronous inbox write.
      const texts = this.queued.get(page) ?? [];
      texts.push({ text, submission, inputId, ...(attachments.length ? { attachments } : {}) });
      void this.refreshSessions();
      this.queued.set(page, texts);
      if (attachments.length) await saveImageInput(page.project, { text, submission, inputId, attachments });
      return this.say(dim("queued; runs after sign-in"), page);
    }
    await this.send(page, text, submission, inputId, attachments);
    this.runTurn(page);
  }

  private lastInterrupt = -Infinity;
  private async interrupt(): Promise<void> {
    this.cancelClear();
    const now = this.clock.now();
    if (now - this.lastInterrupt <= 2000) return this.quit();
    this.lastInterrupt = now;
    const page = this.page;
    if (page?.view) {
      const view = page.view;
      await (this.deps.cancelAgent ?? cancelSession)(page.project, view.name);
      this.toView(page, view, [dim("stopping selected agent. press ctrl+c again within 2 seconds to exit.")]);
    } else {
      page?.orch.cancel?.();
      this.say(dim("turn cancelled. send a message to resume; press ctrl+c again within 2 seconds to exit."), page);
    }
    this.draw();
  }

  /** Ctrl chords that work everywhere (plain control bytes, so they arrive in every terminal; raw mode, so ^Z does not suspend). */
  private readonly chords = new Map<string, () => Promise<void> | void>([
    ["c", () => this.interrupt()],
    ["g", () => this.commands.get("/keys")!.run("", this.page)],
    ["q", () => {
      if (this.menu || this.projectList) return;
      if (this.taskInbox || this.helpTop !== null) return this.questions.command(this.page);
      return this.questions.toggle();
    }],
    ["n", () => this.newPage()],
    ["z", () => this.switchPage(-1)],
    ["x", () => this.switchPage(1)],
    ["t", () => this.toggleTools()],
  ]);

  /** Ctrl+T: the page's runs of finished tool calls call by call, or folded back into one summary line each (the default). */
  private toggleTools(): void {
    const page = this.page;
    if (!page) return;
    page.toolsExpanded = !page.toolsExpanded;
    this.selection.clear(); // the rows under it moved
    this.scrollAnchor = undefined; // captured in the other view's line indexes: a resize would resolve it there
    this.reprint();
  }

  /**
   * Who gets a key: the first layer whose (pure) `takes` says yes. In order:
   * 0. clear: local Cancel-default confirmation owns all keys; navigation cancels it first;
   * 1. keyEcho: /keys echoes every key except Ctrl+C until Esc;
   * 2. chords: Ctrl+C cancels (twice exits), Ctrl+N opens a page, Ctrl+Z / Ctrl+X switch pages, Ctrl+G opens draft-safe /keys, Ctrl+T expands/collapses tool calls;
   * 3. projects: Ctrl+B anywhere (tmux's prefix, hence also /projects), and every key while the list is open and no menu is up;
   * 4. menu: every key while a menu (/model, /agents, /accounts) is open;
   * 5. help: scroll or dismiss the explicit help panel, preserving the composer;
   * 6. inbox: section navigation/dismissal; tasks and empty/agent-view questions own input;
   * 7. questions: the keys the shown question takes (questions.ts `takes`), before Esc/Enter;
   * 8. escape: leaves the agent view, else clears the input;
   * 9. enter: Enter without Shift or Alt submits;
   * 10. editor: the rest edits the input (EDITS, ↑↓ history).
   */
  readonly keyLayers: readonly KeyLayer[] = [
    { name: "clear", takes: () => !!this.clearing, handle: k => this.clearKey(k) },
    { name: "keyEcho", takes: (k) => this.keyEcho && !(k.ctrl && k.name === "c"), handle: (k) => this.echoKey(k) },
    { name: "chords", takes: (k) => !!k.ctrl && this.chords.has(k.name), handle: (k) => this.chords.get(k.name)!() },
    { name: "projects", takes: (k) => this.projectsTake(k), handle: (k) => this.projectsKey(k) },
    { name: "menu", takes: () => !!this.menu, handle: (k) => this.menuKey(k) },
    { name: "help", takes: () => this.helpTop !== null, handle: (k) => this.helpKey(k) },
    { name: "inbox", takes: k => !!this.taskInbox || (!!this.page?.questions.expanded && ((!k.ctrl && !k.alt && (k.name === "escape" && !k.shift || k.name === "tab")) || !this.questions.view())), handle: (k) => this.taskInboxKey(k) },
    { name: "questions", takes: (k) => this.questions.takes(k), handle: (k) => this.questions.handle(k).then(() => this.draw()) },
    { name: "images", takes: k => !!k.ctrl && !k.alt && ["v", "y"].includes(k.name), handle: k => k.name === "v" ? this.pasteImage() : this.removeImage() },
    { name: "escape", takes: (k) => k.name === "escape", handle: () => this.escapeKey() },
    { name: "enter", takes: (k) => k.name === "enter" && !k.shift && !k.alt, handle: () => this.enterKey() },
    { name: "editor", takes: () => true, handle: (k) => { this.edit(k); this.draw(); } },
  ];

  private async selectionMouse(k: Key): Promise<void> {
    const screen = this.screen;
    if (!this.selectionAllowed() || !screen || this.resizeTimer || this.needReprint) {
      this.selection.clear();
      return;
    }
    // Hit-test the painted frame, not the pending scroll destination. Only a
    // new selection pins follow mode; motion/release must not undo queued scroll.
    const completed = this.selection.mouse(k, screen, this.screenHistory);
    if (k.name === "mousedown" && this.selection.active && this.scrollTop === null) this.scrollTop = screen.start;
    this.draw();
    if (completed) await this.copySelection();
  }

  private async copySelection(): Promise<void> {
    if (!this.selectionAllowed() || this.resizeTimer) return;
    // Validate against the latest layout before copying, even between frames.
    this.flush();
    const text = this.selection.text();
    if (!text) return;
    try { await (this.deps.clipboardText ?? writeClipboardText)(text); }
    catch (error) { this.say(dim(`copy failed: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  async onKey(k: Key): Promise<void> {
    if (!this.selectionAllowed()) this.selection.clear();
    if (!this.keyEcho && ["mousedown", "mousemove", "mouseup"].includes(k.name)) return this.selectionMouse(k);
    this.clearNote(k);
    if (!this.keyEcho && k.ctrl && k.name === "o") return this.copySelection();
    if (k.name === "escape" && this.selection.active) { this.selection.clear(); this.draw(); return; }
    // Editing within this draft is fine. Navigation/modal/send/clear/history keys
    // invalidate asynchronous reads, even if the user returns before completion.
    if (!(k.ctrl && k.name === "v") && !typedText(k) && !["left", "right", "backspace", "delete"].includes(k.name)) this.clipboardGeneration++;
    if (this.canScroll(k)) return this.scroll(k);
    if (k.name === "escape") this.modelGeneration++;
    for (const layer of this.keyLayers) if (layer.takes(k)) return layer.handle(k);
  }

  private canScroll(k: Key): boolean {
    return ["pageup", "pagedown", "wheelup", "wheeldown"].includes(k.name) && !this.clearing && !this.keyEcho && !this.menu && !this.projectList && this.helpTop === null && !this.taskInbox && !this.page?.questions.expanded;
  }

  private scroll(k: Key): void {
    const screen = this.screen;
    if (!screen) return;
    const delta = k.name.startsWith("wheel") ? 3 : Math.max(1, screen.bodyHeight - 1);
    const start = this.scrollTop ?? screen.maxStart;
    const top = Math.max(0, Math.min(screen.maxStart, start + (k.name.endsWith("up") ? -delta : delta)));
    this.scrollTop = top === screen.maxStart ? null : top;
    this.scrollAnchor = undefined;
    this.draw();
  }

  /** Only rewrap on width/context changes, not on every live-activity tick. */
  private helpView(): Help | null {
    if (this.helpTop === null) return null;
    const cols = this.deps.term.cols, inView = !!this.page?.view;
    if (this.helpContent?.cols !== cols || this.helpContent.inView !== inView) {
      this.helpContent = { cols, inView, lines: helpLines(this.commands, inView, cols) };
    }
    return { lines: this.helpContent.lines, top: this.helpTop };
  }

  /** Explicit modal, independent of chat/answer buffers and conversation scroll. */
  private toggleHelp(): void {
    this.taskInbox = null;
    this.cancelClear();
    this.helpTop = this.helpTop === null ? 0 : null;
    if (this.helpTop !== null) { this.menu = null; this.projectList = null; }
    this.draw();
  }

  private helpKey(k: Key): void {
    if (k.name === "escape") { this.helpTop = null; this.draw(); return; }
    if (k.ctrl || k.alt) return;
    const panel = helpPanel({ ...this.frame(), rows: this.composerRows() });
    const step = Math.max(1, panel.bodyHeight - 1);
    const delta: Record<string, number> = { up: -1, down: 1, pageup: -step, pagedown: step, wheelup: -3, wheeldown: 3 };
    const top = k.name === "home" ? 0 : k.name === "end" ? panel.maxTop : panel.top + (delta[k.name] ?? 0);
    this.helpTop = Math.max(0, Math.min(panel.maxTop, top));
    this.draw();
  }

  /** Local read-only modal. Opening never changes chat/answer buffers or queues. */
  private toggleTaskInbox(page: Page | undefined): void {
    if (this.taskInbox) { this.taskInbox = null; this.draw(); return; }
    if (!page || page !== this.page || page.deleting || !this.pages.includes(page)) return;
    this.cancelClear();
    this.modelGeneration++;
    this.helpTop = null;
    this.menu = null;
    this.projectList = null;
    this.questions.hide(page);
    this.taskInbox = { page, top: 0, loading: true };
    void this.refreshTaskInbox(page);
    this.draw();
  }

  private taskInboxCurrent(view: TaskInboxState): boolean {
    return !this.closed && this.taskInbox === view && this.page === view.page &&
      this.pages.includes(view.page) && !view.page.deleting;
  }

  private refreshTaskInbox(page = this.page): Promise<void> {
    const view = this.taskInbox;
    if (!view || view.page !== page || !this.taskInboxCurrent(view)) return Promise.resolve();
    if (view.pending) return view.pending;
    view.loading = true;
    view.content = undefined;
    // Promise boundary also catches synchronous failures in an injected store.
    view.pending = Promise.resolve().then(() => (this.deps.tasks ?? listTasks)(view.page.project))
      .then(rows => {
        if (!this.taskInboxCurrent(view)) return;
        view.rows = rows;
        view.error = undefined;
      }, err => {
        if (this.taskInboxCurrent(view)) view.error = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        view.pending = undefined;
        view.loading = false;
        view.content = undefined;
        if (this.taskInboxCurrent(view)) this.draw();
      });
    this.draw();
    return view.pending;
  }

  private taskInboxView(): TaskInboxView | null {
    const view = this.taskInbox;
    if (!view) {
      const page = this.page;
      if (!page?.questions.expanded || page.deleting) return null;
      const q = page.questions;
      return { section: "questions", top: 0, state: q.error ? "error" : !q.loaded ? "loading" : "ready",
        question: this.questions.view(),
        notice: page.view ? "questions belong to the project orchestrator. close inbox, then /back to answer; /agents stays separate."
          : q.error ? `questions unavailable: ${q.error}${q.loaded ? " · last snapshot may be stale." : ""} close and ctrl+q to retry.`
          : q.closing ? QUESTION_PROGRESS[q.closing] : undefined,
        lines: q.error || page.view || q.open.length ? [] : [q.loaded ? "no open questions." : "loading questions…"],
      };
    }
    if (!this.taskInboxCurrent(view)) return null;
    const cols = this.deps.term.cols;
    view.content ??= { cols, ...taskInboxLines(view, cols) };
    if (view.content.cols !== cols) view.content = { cols, ...taskInboxLines(view, cols) };
    return { ...view.content, section: "tasks", top: view.top, state: view.error ? "error" : view.loading ? "loading" : "ready" };
  }

  private taskInboxKey(k: Key): Promise<void> | void {
    if (k.name === "escape" || (k.name === "tab" && !k.ctrl && !k.alt && !k.shift)) {
      this.taskInbox = null;
      if (this.page) this.questions.hide(this.page);
      this.draw(); return;
    }
    // Shift+Tab is navigation, never an option digit or an answer character.
    // Plain Tab retains the existing draft-safe dismissal behavior.
    if (k.name === "tab" && k.shift && !k.ctrl && !k.alt) {
      if (this.taskInbox) return this.questions.command(this.page);
      return this.toggleTaskInbox(this.page);
    }
    const view = this.taskInbox;
    if (!view) return; // empty/loading/agent-view Questions owns input, too
    if (k.ctrl || k.alt) return;
    if (k.name === "char" && k.text === "r") { void this.refreshTaskInbox(); return; }
    const panel = taskInboxPanel({ ...this.frame(), rows: this.composerRows() });
    const step = Math.max(1, panel.bodyHeight - 1);
    const delta: Record<string, number> = { up: -1, down: 1, pageup: -step, pagedown: step, wheelup: -3, wheeldown: 3 };
    const top = k.name === "home" ? 0 : k.name === "end" ? panel.maxTop : panel.top + (delta[k.name] ?? 0);
    view.top = Math.max(0, Math.min(panel.maxTop, top));
    this.draw();
  }

  /** /keys: show each key as parsed; Esc ends. */
  private echoKey(k: Key): void {
    if (k.name !== "escape") return this.say(dim(JSON.stringify(k)));
    this.keyEcho = false;
    this.say(dim("done"));
  }

  /** Keys while a menu is open: ↑ Ctrl+P k up, ↓ j down, Enter picks, Esc q cancels; the rest do nothing. */
  private async menuKey(k: Key): Promise<void> {
    const m = this.menu!;
    const id = menuKeyId(k);
    const n = m.items.length;
    if (id === "up") m.index = (m.index + n - 1) % n;
    else if (id === "down") m.index = (m.index + 1) % n;
    else if (id === "enter") { this.menu = null; await m.pick(m.index); }
    else if (id === "escape") { this.modelGeneration++; this.menu = null; }
    return this.draw();
  }

  /** Esc: leave the agent view, else clear the input. */
  private escapeKey(): void {
    if (this.page?.view) this.page.view.leave();
    else { this.input = { text: "", cursor: 0 }; if (this.page) this.draftImages.delete(this.page); }
    return this.draw();
  }

  /** Enter: send the input, dropping blank lines around it but keeping the first line's indent. */
  private enterKey(): Promise<void> | void {
    const text = this.input.text.replace(/^\s*\n/, "").trimEnd();
    const attachments = this.images();
    if (attachments.length && text.trimStart().startsWith("/")) {
      this.say(dim("draft images are not sent with slash commands. ctrl+y removes the last image; esc clears this draft."));
      return this.draw();
    }
    if (attachments.length && Buffer.byteLength(text) > 60000) return this.say(dim("image prompt text exceeds 60,000 bytes; shorten it before sending. draft retained."));
    if (attachments.length && this.page?.view) return this.say(dim("return to project chat before sending images."));
    if (this.page) this.draftImages.delete(this.page);
    if (text !== "/help" && text !== "/inbox" && text !== "/questions" && text !== "/refresh") this.scrollTop = null;
    this.input = { text: "", cursor: 0 };
    this.historyAt = -1;
    if (!text && !attachments.length) return this.draw();
    this.remember(text);
    this.draw();
    return this.submit(text, attachments);
  }

  /** Editing on the input area; the logic lives in editor.ts. */
  private edit(k: Key): void {
    const text = typedText(k);
    if (text) { this.input = ed.insert(this.input, text); return; }
    if (k.name === "up" || k.name === "down") return this.upDown(k.name === "up" ? -1 : 1);
    const action = EDITS[`${k.ctrl ? "C-" : ""}${k.alt ? "M-" : ""}${k.name}`];
    if (action) this.input = action(this.input);
  }

  /** Up / Down move between rows; on the first / last row they walk the history. */
  private upDown(dir: -1 | 1): void {
    const moved = ed.vertical(this.input, this.inputWidth(this.prompt()), dir);
    if (moved) this.input = moved;
    else this.recall(dir);
  }


  /** Track input until an exact committed receipt (local callback or shared refresh); failed writes are reported explicitly. */
  private async send(page: Page, text: string, submission?: string, inputId: string = crypto.randomUUID(), attachments: ImageRef[] = []): Promise<void> {
    const sent = page.sent.find(m => m.inputId === inputId) ?? { inputId, text, submission, ...(attachments.length ? { attachments } : {}), retry: false };
    if (!page.sent.includes(sent)) page.sent.push(sent);
    sent.retry = false;
    this.draw();
    try {
      // Start publication before refresh and never await a refresh to submit.
      const publish = async () => {
        if (attachments.length) await saveImageInput(page.project, { inputId, text, submission, attachments });
        return { writing: page.orch.say(text, submission, sent.inputId, attachments) };
      };
      const prior = this.sending.get(page);
      const prepared = prior ? prior.then(publish) : publish();
      // Reserve inbox invocation order, not completion: put owns disk FIFO, and
      // later sends must still be attempted after an earlier delayed failure.
      const gate = prepared.then(() => {}, () => {});
      this.sending.set(page, gate);
      void gate.then(() => { if (this.sending.get(page) === gate) this.sending.delete(page); });
      void this.refreshSessions(false);
      const { writing } = await prepared;
      await writing;
    }
    catch (err) {
      const at = page.sent.indexOf(sent);
      if (attachments.length) sent.retry = true;
      else if (at !== -1) page.sent.splice(at, 1);
      this.say(dim(`not sent: ${text}${imageLabels(attachments)}${attachments.length ? "; retained in this window for /retry-images" : ""}`), page);
      throw err;
    } finally { this.draw(); }
  }

  /** Add a sent line (only plain messages and harmless commands; nothing while signing in) to the active page's input history and save it (or keep it in memory while no page is open). */
  private remember(text: string): void {
    if (!keepable(text, this.loggingIn)) return;
    const page = this.page;
    if (!page) { this.looseHistory = remember(this.looseHistory, text); return; }
    const before = page.inputHistory;
    page.inputHistory = remember(before, text);
    if (page.inputHistory === before) return;
    page.savingHistory = page.savingHistory
      .then(async () => { page.historyLines = await appendHistory(page.project, text, page.historyLines); })
      .catch((err) => this.say(dim(`could not save input history: ${err instanceof Error ? err.message : String(err)}`), page));
  }

  private recall(dir: -1 | 1): void {
    if (this.images().length) return this.say(dim("remove draft images (ctrl+y) before recalling a different prompt from history."));
    const page = this.page;
    if (this.historyPage !== page) { this.historyPage = page; this.historyAt = -1; }
    const history = page?.inputHistory ?? this.looseHistory;
    if (dir === -1 && this.historyAt + 1 < history.length) this.historyAt++;
    else if (dir === 1 && this.historyAt >= 0) this.historyAt--;
    else return;
    const t = this.historyAt === -1 ? "" : history[history.length - 1 - this.historyAt]!;
    this.input = { text: t, cursor: t.length };
  }
}
