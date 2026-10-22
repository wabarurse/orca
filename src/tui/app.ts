import { cancelSession } from "../cancellation";
import { effortCommand, fastCommand, effectiveSettings, type RequestSettings } from "../project-settings";
// Sticky top and bottom bars around a scrollable conversation. Only changed
// screen rows are redrawn; on exit the active transcript is printed back to
// the terminal's normal scrollback. One page per orchestrator: Ctrl+N starts one named
// orch-xxxx (/rename gives it a display name), Ctrl+Z and Ctrl+X move between
// them, Ctrl+B or /projects lists every project (open, pin, delete) like a
// menu. Type to talk to the page's orchestrator; worker and reviewer reports
// arrive through its inbox and show up while you wait. /help lists the commands.

import { accountChoices, deleteProject, exitWatchdog, mergeWatch, displayName, listAgents, liveAgents, liveAgentsOrNull, listProjects, login, modelChoices, newProjectName, orderedProjects, projectFor, remoteOf, reviewRounds, setDisplayName, setModel, shortRemote, togglePin, useAccount, validProjectName, type Choice, type DeleteOptions, type ProjectEntry } from "../commands";
import { paths } from "../config";
import { projectIdentity } from "../project-state";
import { validateModel, effectiveModel } from "../project-model";
import type { Message } from "../inbox";
import type { Orchestrator } from "../orchestrator";
import { format } from "node:util";
import { follow, parts } from "../view";
import * as ed from "./editor";
import type { Key } from "./keys";
import { historyRows, type Line } from "./lines";
import { appendHistory, keepable, loadHistory, remember } from "./history";
import { MarkdownStream } from "./mdstream";
import { helpLines, type CommandHelp } from "./help";
import { pageQuestions, Questions, QUESTION_DELAY_MS, type PageQuestions, type QuestionStore } from "./questions";
import { replyLine, reportLine, restore, userLines } from "./restore";
import { bold, commit, dim, helpPanel, inputArea, inputGeometry, statusRows, type Frame, type Help, type Input, type InputArea, type Menu } from "./render";
import type { Terminal } from "./term";
import { shimmer } from "./shimmer";
import { chapterRows, headerHeight } from "./chrome";
import { captureAnchor, resolveAnchor, type HistoryAnchor } from "./anchor";
import { Calls } from "./tools";
import type { ToolCall, ToolOutcome } from "../toolview";
import { stickyRows, stickyUpdate, type StickyScreen } from "./sticky";

export { helpLines } from "./help";
export { lineRows, type Line } from "./lines";

export interface Page {
  /** The project id: its folder under ~/.parallels/projects. Never changes. */
  project: string;
  /** What the header tab shows; /rename sets it. */
  name: string;
  orch: Orchestrator;
  /** Where the clone came from, for the pinned header. */
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
  sent: { readonly inputId: string; text: string }[];
  /** The orchestrator's open questions for the user, polled from questions/ (questions.ts). */
  questions: PageQuestions;
  /** Answered-question lines waiting for the streaming reply's partial line to end, so they never split it. */
  held: Line[];
  /** Set while an agent's transcript is showing; calling leave returns to the page. */
  view: { name: string; lines: Line[]; leave: () => void; live: boolean; calls: Calls } | null;
  /** The orchestrator's tool calls running now, shown in the live region (tools.ts). */
  calls: Calls;
  model?: string;
  settings?: RequestSettings;
  agentCount?: number;
}

export interface AppDeps {
  /** Cached header model accessor; defaults to effectiveModel(project). */
  projectModel?: (project: string) => Promise<string>;
  term: Terminal;
  /** Make sure the project exists (cloning when a url is given) and build its orchestrator. */
  /** `write` gets streamed model text (markdown) and, with `plain` set, tool lines shown as they are; `onInbox` gets each batch of messages the orchestrator reads. */
  /** `tools` gets each tool call as it starts and ends: running in the live region, then its "⏺" line and summary in the history. */
  openOrchestrator(project: string, url: string | undefined, write: (text: string, plain?: boolean) => void, onInbox?: (msgs: Message[]) => void, tools?: ToolEvents): Promise<Orchestrator>;
  /** Inbox poll period; tests shorten it. */
  pollMs?: number;
  /** Clone source of the repository `start` was run from, if any: opened on start and cloned by Ctrl+N. */
  source?: string | null;
  /** Clock and repeating timer for the busy spinner; tests inject fakes so they never sleep. */
  clock?: Clock;
  /** A project's agents and which are live: /agents lists these and live views poll them. Defaults to listAgents for the menu and to tmux alone (liveAgents) for the poll. */
  cancelAgent?: typeof cancelSession;
  agents?: (project: string) => Promise<{ name: string; live: boolean }[]>;
  /** Sign-in; tests replace it. */
  login?: typeof login;
  modelChoices?: typeof modelChoices;
  modelAgents?: (project: string) => Promise<string[] | null>;
  saveModel?: typeof setModel;
  /** How the project list checks for live agents and closes a deleted project's tmux session; tests stub them. */
  projects?: Pick<DeleteOptions, "live" | "kill">;
  /** Exit watchdog run with each inbox poll (commands.ts exitWatchdog); tests stub it. */
  watchdog?: (project: string) => Promise<unknown>;
  /** Merged-PR watcher run with each inbox poll (commands.ts mergeWatch); tests stub it. */
  merges?: (project: string) => Promise<unknown>;
  /** Where questions are read and answered (questions.ts on disk by default); tests stub it. */
  questions?: QuestionStore;
  /** How long Enter, digits and typing are ignored after a question first shows (QUESTION_DELAY_MS); tests shorten it. */
  questionDelayMs?: number;
}

export interface ToolEvents { onTool(call: ToolCall): void; onToolResult(outcome: ToolOutcome): void }

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

/** The project list (Ctrl+B, /projects): every project on disk, pinned first. Takes the keys while open. */
interface ProjectListState { items: ProjectEntry[]; index: number; status: string; confirm: ProjectEntry | null }

interface ActiveMenu extends Menu { pick: (index: number) => Promise<void> | void }

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
  private _active = 0;
  get active(): number { return this._active; }
  set active(index: number) {
    if (index !== this._active) { this.modelGeneration++; this.helpTop = null; }
    this._active = index;
  }
  private looseLines: string[] = [];
  input = { text: "", cursor: 0 };
  /** First input row on screen, kept between frames so the input area scrolls only when the cursor leaves it. */
  private inputTop: number | undefined;
  /** Null until explicitly opened; only a footer scroll position, never a history line. */
  private helpTop: number | null = null;
  private helpContent?: { cols: number; inView: boolean; lines: string[] };
  menu: ActiveMenu | null = null;
  projectList: ProjectListState | null = null;
  loggingIn = false;
  /** Text typed while signing in, per page; sent when sign-in succeeds, dropped when it fails. */
  private readonly queued = new Map<Page, { text: string; submission?: string }[]>();
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

  /** The active page's oldest open question in the live region, and the keys it takes (questions.ts). */
  readonly questions: Questions;

  constructor(private readonly deps: AppDeps) {
    this.finished = new Promise<void>((r) => (this.done = r));
    const app = this;
    this.questions = new Questions({
      page: () => app.page,
      get input() { return app.input; },
      set input(v) { app.input = { text: v.text, cursor: v.cursor }; },
      say: (line, page) => app.say(line, page as Page),
      record: (line, page) => app.record(page as Page, line),
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
      if (this.page) { this.checkLive(this.page.project); void this.refreshHeader(this.page).catch(() => {}); }
      this.watchPages();
      this.questions.poll(this.pages);
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
      this.loginAbort.abort();
      for (const p of this.pages) { p.orch.cancel?.(); p.view?.leave(); }
      restoreConsole();
      term.close();
      this.leave();
    }
  }

  /** The given project, or every known one plus the repo we were started in, or a fresh orch-xxxx. */
  private async openStartPages(project?: string, url?: string): Promise<void> {
    if (project) { await this.openPage(project, url); return; }
    for (const name of await listProjects()) await this.openPage(name);
    const source = this.deps.source;
    if (source) {
      // Reuse the project already cloned from this repo, else start a fresh orch-xxxx on it.
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

  quit(): void { this.modelGeneration++; this.done(); }

  // --- output -----------------------------------------------------------------

  /** Append a finished line to the page's agent view if one is up, else to the page (or the screen when there is none). */
  say(line: string, page = this.page): void {
    if (!page) { this.looseLines.push(line); this.pending.push(line); return this.draw(); }
    if (page.view) this.toView(page, page.view, [line]);
    else this.toPage(page, [line]);
  }

  /** Finished lines of the page's own history; they reach the screen only while it is active and shows no agent. */
  private toPage(page: Page, lines: Line[]): void {
    const previous = page.lines.at(-1);
    page.lines.push(...lines);
    if (this.started && page === this.page && !page.view) this.pending.push(...this.rows(lines, previous));
    this.draw();
  }

  /** Finished lines of an agent view; on screen only while it is what the active page shows. */
  private toView(page: Page, view: NonNullable<Page["view"]>, lines: Line[]): void {
    const previous = view.lines.at(-1);
    view.lines.push(...lines);
    if (this.started && page === this.page && page.view === view) this.pending.push(...this.rows(lines, previous));
    this.draw();
  }

  /** What the screen shows for the active page: its agent view or its history. */
  private screenLines(page = this.page): string[] {
    return page ? this.rows(page.view?.lines ?? page.lines) : this.looseLines;
  }

  /** History lines laid out at the terminal's width. */
  private rows(lines: Line[], previous?: Line): string[] {
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
      const at = m.inputId ? page.sent.findIndex(item => item.inputId === m.inputId) : -1;
      if (at !== -1) { page.sent.splice(at, 1); this.toPage(page, userLines(m.text)); continue; }
      // A question's answer: its dim line, unless answered here (shown then); anything else from elsewhere (`parallels msg`) as "> …", as restore shows it.
      this.toPage(page, this.questions.inboxLines(page, m.text) ?? userLines(m.text));
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
    if (page.md.pending) page.held.push(line);
    else this.toPage(page, [line]);
  }

  frame(): Frame {
    const page = this.page;
    const status = this.started && page ? this.status(page) : null;
    const { input, area } = this.inputFrame(statusRows(status, this.deps.term.cols, this.composerRows()).length);
    return {
      cols: this.deps.term.cols, rows: this.deps.term.rows,
      partial: page && !page.view ? page.md.pending : "",
      running: page ? (page.view?.calls ?? page.calls).rows(this.clock.now(), this.deps.term.cols) : [],
      activity: !this.started ? dim("opening…") : page ? this.activity(page) : undefined,
      status, input, inputArea: area,
      // Project-owned submitted text only: never reconstruct from conversation
      // user lines or from the chat/answer draft. This is presentation, not delivery.
      queued: page ? { project: page.name, texts: [...page.sent.map(item => item.text), ...(this.queued.get(page) ?? []).map(item => item.text)] } : undefined,
      menu: this.menu,
      help: this.helpView(),
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

  private header(page: Page): string[] {
    const settings = page.settings;
    const model = `${page.model ?? "loading model…"} · effort ${settings ? settings.effort ?? "default" : "…"} · fast ${settings ? settings.fast ? "on" : "off" : "…"}`;
    return chapterRows({ tabs: this.pages, active: this.pages.indexOf(page), model, directory: paths.repo(page.project), remote: page.remote ? shortRemote(page.remote) : "no remote", agent: page.view?.name }, this.deps.term.cols, headerHeight(this.deps.term.rows));
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
    if (model === page.model && JSON.stringify(settings) === JSON.stringify(page.settings)) return;
    page.model = model;
    page.settings = settings;
    if (page === this.page) this.draw();
  }

  private spinner(): string { return SPINNER[Math.floor(this.clock.now() / SPIN_MS) % SPINNER.length]!; }

  /** Counts only: no shortcuts, repeated identities or transient animation in the footer. */
  status(page: Page): string {
    const agents = page.agentCount ?? 0;
    const queued = page.sent.length + (this.queued.get(page)?.length ?? 0);
    const questions = page.questions.open.length;
    const elsewhere = this.pages.reduce((n, p) => n + (p === page ? 0 : p.questions.open.length), 0);
    return [`${agents} ${agents === 1 ? "agent" : "agents"} running`, `${queued} ${queued === 1 ? "message" : "messages"} queued`, `${questions} ${questions === 1 ? "question" : "questions"}${elsewhere ? ` (+${elsewhere} elsewhere)` : ""}`].join(" │ ");
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
    const fast = this.shimmering();
    const ms = fast ? TICK_MS : SPIN_MS;
    const want = !this.closed && (fast || this.pages.some(active));
    if (this.tickMs !== ms || !want) { this.stopSpinner?.(); this.stopSpinner = null; }
    this.tickMs = ms;
    if (want && !this.stopSpinner) this.stopSpinner = this.clock.every(() => this.tick(), ms);
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
    if (this.closed) return;
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

  private viewport(f: Frame): StickyScreen {
    const owner = this.page?.view ?? this.page;
    this.anchorScroll(owner, f.cols);
    if (this.needReprint || owner !== this.screenOwner) this.screenHistory = this.started ? this.screenLines() : [...this.looseLines];
    else this.screenHistory.push(...this.pending);
    this.screenOwner = owner;
    this.pending = [];
    const chrome = this.page ? this.header(this.page) : [];
    const screen = stickyRows(f, this.screenHistory, chrome, this.scrollTop);
    if (this.scrollTop !== null) this.scrollTop = screen.start;
    return screen;
  }

  /** Only a resize of the same conversation can reuse its scroll anchor. */
  private anchorScroll(owner: typeof this.screenOwner, cols: number): void {
    if (owner !== this.screenOwner) this.scrollTop = null;
    if (this.scrollTop === null) { this.scrollAnchor = undefined; return; }
    if (!this.screen || this.screen.cols === cols) return;
    const lines = this.page?.view?.lines ?? this.page?.lines ?? this.looseLines;
    this.scrollAnchor ??= captureAnchor(lines, this.screen.cols, this.scrollTop);
    this.scrollTop = resolveAnchor(lines, cols, this.scrollAnchor);
  }

  /** The last drawing error said, so a frame that keeps failing is reported once. */
  private drawError = "";

  /** After restoring the primary screen, print the active history and any partial reply. */
  private leave(): void {
    const page = this.page;
    const held = page && !page.view ? page.md.pending : "";
    const history = page?.view?.lines ?? page?.lines ?? this.looseLines;
    const lines = [...(page ? this.header(page) : []), ...historyRows(history, this.deps.term.cols), ...(held ? held.split("\n") : [])];
    this.pending = [];
    this.deps.term.write(`\x1b[0m${commit(lines, this.deps.term.cols)}\x1b[?25h`);
  }

  // --- pages ------------------------------------------------------------------

  private restorePage(page: Page, asked: import("./restore").AskedLookup): void {
    const entries = page.orch.entries?.() ?? [];
    // All saved conversation must be scrollable before exit, including originals
    // before model compaction. Cache rendered rows in viewport(); only the visible
    // slice is drawn on keys/ticks, rather than capping access to older messages.
    page.lines = [...restore(entries, this.deps.term.cols, Infinity, asked), ...page.lines];
  }

  async openPage(project: string, url?: string): Promise<Page> {
    this.modelGeneration++;
    const existing = this.pages.findIndex((p) => p.project === project);
    if (existing !== -1) {
      if (existing !== this.active) { this.active = existing; this.reprint(); }
      return this.pages[existing]!;
    }
    const page: Page = { project, name: project, orch: null as unknown as Orchestrator, remote: "", lines: [], md: new MarkdownStream(), busy: false, busySince: 0, streamed: false, inputHistory: [], historyLines: 0, savingHistory: Promise.resolve(), sent: [], questions: pageQuestions(), held: [], view: null, calls: new Calls() };
    const tools: ToolEvents = { onTool: (call) => this.toolStarted(page, call), onToolResult: (outcome) => this.toPage(page, [page.calls.finish(outcome)]) };
    page.orch = await this.deps.openOrchestrator(project, url, (text, plain) => this.stream(page, text, plain), (msgs) => this.inbox(page, msgs), tools);
    // Like `claude --continue`: the page starts with what its transcript showed live (from the transcript the orchestrator loaded), and ↑ recalls what was typed.
    const asked = await this.questions.load(page);
    this.restorePage(page, asked);
    const saved = await loadHistory(project);
    page.inputHistory = saved.entries;
    page.historyLines = saved.lines;
    page.remote = await remoteOf(project);
    page.name = await displayName(project);
    page.lines.unshift(...this.looseLines);
    this.looseLines = [];
    page.model = await this.readModel(project);
    page.settings = await effectiveSettings(project, page.model).catch(() => undefined);
    this.pages.push(page);
    this.active = this.pages.length - 1;
    this.checkLive(project);
    this.questions.poll([page]);
    this.reprint();
    if (this.projectList) await this.refreshProjects();
    return page;
  }

  closePage(index = this.active): void {
    this.helpTop = null;
    this.modelGeneration++;
    const page = this.pages[index];
    if (!page) return;
    page.view?.leave();
    this.pages.splice(index, 1);
    if (index < this.active) this.active--;
    this.active = Math.min(this.active, Math.max(0, this.pages.length - 1));
    this.reprint();
  }

  switchPage(delta: number): void {
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

  /** Start a fresh orchestrator named orch-xxxx (or `name`), cloning `url`, else the repo we were started in. */
  async newPage(name?: string, url?: string): Promise<void> {
    const shown = await this.shownNames();
    if (name && [...shown].some(([id, n]) => id !== name && n === name)) return this.say(dim(`another project is already called ${name}`));
    const project = name ?? newProjectName([...shown.keys(), ...shown.values()]);
    try {
      const page = await this.openPage(project, url ?? this.deps.source ?? undefined);
      if (!name) this.say(dim("/rename <name> to rename"), page);
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
      this.say(dim(`${from} → ${page.name}`), page);
      if (this.projectList) await this.refreshProjects();
    } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`, page); }
  }

  // --- project list -----------------------------------------------------------

  /** Ctrl+B: open the project list, or close it. */
  toggleProjects(): Promise<void> | void {
    return this.projectList ? this.closeProjects() : this.openProjects();
  }

  async openProjects(): Promise<void> {
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
    const items = await orderedProjects();
    const list = this.projectList;
    if (!list) return;
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
    if (page.busy || page.deleting) return;
    page.busy = true;
    page.busySince = this.clock.now();
    page.streamed = false;
    this.draw();
    try {
      for (const reply of await page.orch.turn()) {
        this.endPartial(page);
        this.toPage(page, [replyLine(reply.from, reply.text)]);
      }
    } catch (err) {
      this.endPartial(page);
      this.toPage(page, [`${bold("error")} ${err instanceof Error ? err.message : String(err)}; turn stopped. Send another message to resume with retained history; changing model alone does not retry. Exited agents require restart.`]);
    } finally {
      this.endPartial(page);
      page.busy = false;
      this.toPage(page, page.calls.interrupt());
      this.draw();
    }
  }

  // --- menus ------------------------------------------------------------------

  openMenu<T>(title: string, choices: Choice<T>[], pick: (value: T) => Promise<void> | void, modelOperation?: number): void {
    if (modelOperation === undefined) this.modelGeneration++;
    if (!choices.length) return;
    this.helpTop = null;
    this.menu = {
      title: dim(title) + dim("   ↑↓ Enter   Esc cancels"),
      items: choices.map((c) => `${c.current ? "●" : " "} ${c.label}`),
      index: Math.max(0, choices.findIndex((c) => c.current)),
      pick: (i) => pick(choices[i]!.value),
    };
    this.draw();
  }

  private async agentsMenu(page: Page): Promise<void> {
    this.modelGeneration++;
    const agents = await (this.deps.agents ?? listAgents)(page.project);
    if (!agents.length) return this.say(dim("no agents yet"));
    this.openMenu("attach to an agent", agents.map((a) => ({ value: a.name, label: `${a.name}  ${dim(a.live ? "live" : "finished")}` })), (name) => {
      page.view?.leave();
      return this.attach(page, name, agents.find((a) => a.name === name)?.live ?? false);
    });
  }

  private async accountsMenu(): Promise<void> {
    this.modelGeneration++;
    this.openMenu("accounts: Enter uses one or signs it in", await accountChoices(dim), async (account) => {
      if (account.ok) return this.say(dim(await useAccount(account)));
      await this.login(`${account.provider} ${account.id.split(":")[1]}`);
    });
  }

  private async modelsMenu(page: Page, operation: number, identity: string): Promise<void> {
    this.say(dim("fetching models…"));
    const { choices, errors } = await (this.deps.modelChoices ?? modelChoices)(dim, page.project);
    if (!this.modelPageCurrent(page, operation)) return;
    for (const e of errors) this.say(dim(e));
    if (!choices.length) return this.say(dim("no models available; sign in with /login first"));
    this.openMenu("switch model   (/models <id> for any other id)", choices, async (id) => this.switchModel(page, id, operation, identity), operation);
  }

  private async attach(page: Page, name: string, live: boolean): Promise<void> {
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r, live, calls: new Calls() }));
    const view = page.view!;
    if (page === this.page) this.reprint();
    this.say(dim("Esc or /back returns"), page);
    await follow(paths.transcript(page.project, name), (_s, entry) => this.toView(page, view, view.calls.absorb(parts(entry) ?? [])), stopped, 300, () => { if (!view.live) this.toView(page, view, view.calls.interrupt()); });
    if (page.view === view) {
      page.view = null;
      if (page === this.page) this.reprint();
    }
    this.draw();
  }

  private watch?: (project: string) => Promise<unknown>;
  private merges?: (project: string) => Promise<unknown>;

  /** Exit watchdog and merged-PR watcher for every open page (commands.ts); notices land in the orchestrator's inbox. */
  private watchPages(): void {
    this.watch ??= this.deps.watchdog ?? exitWatchdog();
    this.merges ??= this.deps.merges ?? mergeWatch();
    for (const p of this.pages) for (const w of [this.watch, this.merges]) w(p.project).catch(() => {});
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

  private async drainLoginPage(page: Page, texts: { text: string; submission?: string }[], ok: boolean): Promise<void> {
    if (!ok) this.say(dim(`sign-in failed; dropped ${texts.length} queued message(s)`), page);
    while (texts.length) {
      const { text, submission } = texts.shift()!; // ownership transfers to send (Page.sent), or an explicit drop report
      if (ok && this.pages.includes(page)) await this.send(page, text, submission).catch(() => {});
      else this.say(dim(`not sent after sign-in (${page.name}): ${text}`), this.pages.includes(page) ? page : this.page);
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
    ["/projects", { run: () => this.openProjects(), help: { group: "projects", label: "/projects", description: "Browse projects: Enter opens, p pins, d deletes" } }],
    ["/keys", { run: () => { this.keyEcho = true; this.say(dim("press keys; Esc ends")); }, help: { group: "advanced", label: "/keys", description: "Diagnose keys/wheel; Ctrl+G keeps draft; Esc ends" } }],
    ["/rename", { args: true, run: (args) => this.renamePage(args), help: { group: "projects", label: "/rename <name>", description: "Change display name only; project ID stays fixed" } }],
    ["/new", { args: true, run: (args) => this.newCommand(args), help: { group: "projects", label: "/new [name] [git-url]", description: "Create a project page" } }],
    ["/close", { run: () => this.closePage(), help: { group: "projects", label: "/close", description: "Close this page; keep its project and history" } }],
    ["/quit", { run: () => this.quit(), help: { group: "projects", label: "/quit", description: "Exit; keep conversation history" } }],
    ["/agents", { needsPage: true, run: (_, page) => this.agentsMenu(page!), help: { group: "conversation", label: "/agents", description: "Browse and follow agent conversations" } }],
    ["/effort", { args: true, run: (args, page) => this.requestSetting(page, args, effortCommand), help: { group: "settings", label: "/effort [level|default]", description: "Show or set project/model reasoning effort" } }],
    ["/fast", { args: true, run: (args, page) => this.requestSetting(page, args, fastCommand), help: { group: "settings", label: "/fast [on|off]", description: "Show or set project/model fast mode" } }],
    ["/compact", { needsPage: true, run: async (_, page) => { await page!.orch.compact?.(); }, help: { group: "advanced", label: "/compact", description: "Summarize model context; keep full history" } }],
    ["/models", { args: true, run: (args, page) => this.modelsCommand(args, page), help: { group: "settings", label: "/models [id]", description: "Choose or set the project model" } }],
    ["/accounts", { run: () => this.accountsMenu(), help: { group: "settings", label: "/accounts", description: "Choose a subscription account" } }],
    ["/login", { args: true, run: (args) => this.login(args), help: { group: "settings", label: "/login claude|codex [profile]", description: "Sign in to a subscription account" } }],
    ["/review-rounds", { args: true, run: async (args) => this.say(dim(await reviewRounds(args))), help: { group: "advanced", label: "/review-rounds [n]", description: "Review rounds before CI; 0 goes straight to CI" } }],
    ["/questions", { run: (_, page) => this.questions.command(page), help: { group: "conversation", label: "/questions", description: "Open questions; Enter answers or picks skip, Esc/Tab closes" } }],
    ["/back", { run: (_, page) => (page?.view ? page.view.leave() : this.say(dim("not viewing an agent"))), help: { group: "conversation", label: "/back", description: "Return from agent view (also Esc)", viewOnly: true } }],
    ["/help", { run: () => this.toggleHelp(), help: { group: "conversation", label: "/help", description: "Commands and keyboard shortcuts; Esc closes" } }],
  ]);

  /** /new [name] [git-url]: the name must be a valid project id. */
  private newCommand(args: string): Promise<void> | void {
    const [name, url] = args.split(/\s+/).filter(Boolean);
    if (name && !validProjectName(name)) return this.say(dim("project ids are letters, digits, . _ or -; /rename sets a free-form name"));
    return this.newPage(name, url);
  }

  /** /models opens the menu; /models <id> sets any id. */
  private async requestSetting(page: Page | undefined, args: string, command: typeof effortCommand): Promise<void> {
    if (!page) return this.say(dim("open a project before changing its model settings"));
    this.say(dim(await command(page.project, args)), page);
    await this.refreshHeader(page);
  }

  private async modelsCommand(id: string, page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.say(dim("open a project before changing its model"));
    const identity = projectIdentity(page.project);
    if (!id) return this.modelsMenu(page, operation, identity);
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
    this.openMenu(`Switch this project to ${id}? Applies to orchestrator, ${workers} workers and ${reviewers} reviewers. Running tools finish; agents switch before their next model request.`, [
      { value: false, label: "Cancel", current: true },
      { value: true, label: "Switch all" },
    ], async (confirmed) => { if (confirmed) await save(); }, operation);
  }

  private async commitModel(page: Page, id: string, operation: number, identity: string): Promise<void> {
    if (!this.modelPageCurrent(page, operation)) return;
    // Persistence boundary: once invoked, this commit belongs to the captured
    // project even if its page closes or selection changes. Disk identity and
    // the shared project-state lock protect deletion/recreation, not selection.
    const result = await (this.deps.saveModel ?? setModel)(id, page.project, identity);
    this.say(dim(result), page);
    await this.refreshHeader(page);
  }

  /**
   * A sent line, guarded in this order:
   * 1. a known command that needs no page runs at once (agent view, sign-in, no page: all fine);
   * 2. with no page open, anything else (/agents, an unknown command, plain text) opens a fresh orch-xxxx and is dropped;
   * 3. a known command runs on the page;
   * 4. an unknown one (or arguments to a command that takes none) says "unknown command /x";
   * 5. plain text goes to the orchestrator (talk), refused in an agent view and queued while signing in.
   */
  private async submit(text: string): Promise<void> {
    const call = parseCommand(text, this.commands);
    if (call && call.name !== "/models") this.modelGeneration++;
    if (call?.command && !call.command.needsPage) return call.command.run(call.args, this.page);
    const page = this.page;
    if (!page) return this.newPage();
    if (call?.command) return call.command.run(call.args, page);
    if (call) return this.say(dim(`unknown command ${call.name}`));
    return this.talk(page, text);
  }

  /** Plain text for the page's orchestrator: refused while viewing an agent, held while signing in. */
  private async talk(page: Page, text: string): Promise<void> {
    if (page.view) return this.say(dim(`viewing ${page.view.name}; /back first to talk to the orchestrator`));
    // While signing in the text waits in the app; login() sends it only if sign-in succeeds.
    if (this.loggingIn || this.queued.has(page)) {
      // Append to the same owner while login is draining too, so a new submit
      // cannot overtake older held input during an asynchronous inbox write.
      const texts = this.queued.get(page) ?? [];
      texts.push({ text, submission: page.orch.submission?.() });
      this.queued.set(page, texts);
      return this.say(dim("queued; runs after sign-in"), page);
    }
    await this.send(page, text);
    this.runTurn(page);
  }

  private lastInterrupt = -Infinity;
  private async interrupt(): Promise<void> {
    const now = this.clock.now();
    if (now - this.lastInterrupt <= 2000) return this.quit();
    this.lastInterrupt = now;
    const page = this.page;
    if (page?.view) {
      const view = page.view;
      await (this.deps.cancelAgent ?? cancelSession)(page.project, view.name);
      this.toView(page, view, [dim("Stopping selected agent. Press Ctrl+C again within 2 seconds to exit.")]);
    } else {
      page?.orch.cancel?.();
      this.say(dim("Turn cancelled. Send a message to resume; press Ctrl+C again within 2 seconds to exit."), page);
    }
    this.draw();
  }

  /** Ctrl chords that work everywhere (plain control bytes, so they arrive in every terminal; raw mode, so ^Z does not suspend). */
  private readonly chords = new Map<string, () => Promise<void> | void>([
    ["c", () => this.interrupt()],
    ["g", () => this.commands.get("/keys")!.run("", this.page)],
    ["q", () => { if (!this.menu && !this.projectList) { this.helpTop = null; this.draw(); return this.questions.toggle(); } }],
    ["n", () => this.newPage()],
    ["z", () => this.switchPage(-1)],
    ["x", () => this.switchPage(1)],
  ]);

  /**
   * Who gets a key: the first layer whose (pure) `takes` says yes. In order:
   * 1. keyEcho: /keys echoes every key except Ctrl+C until Esc;
   * 2. chords: Ctrl+C cancels (twice exits), Ctrl+N opens a page, Ctrl+Z / Ctrl+X switch pages, Ctrl+G opens draft-safe /keys;
   * 3. projects: Ctrl+B anywhere (tmux's prefix, hence also /projects), and every key while the list is open and no menu is up;
   * 4. menu: every key while a menu (/models, /agents, /accounts) is open;
   * 5. help: scroll or dismiss the explicit help panel, preserving the composer;
   * 6. questions: the keys the shown question takes (questions.ts `takes`), before Esc/Enter;
   * 7. escape: leaves the agent view, else clears the input;
   * 8. enter: Enter without Shift or Alt submits;
   * 9. editor: the rest edits the input (EDITS, ↑↓ history).
   */
  readonly keyLayers: readonly KeyLayer[] = [
    { name: "keyEcho", takes: (k) => this.keyEcho && !(k.ctrl && k.name === "c"), handle: (k) => this.echoKey(k) },
    { name: "chords", takes: (k) => !!k.ctrl && this.chords.has(k.name), handle: (k) => this.chords.get(k.name)!() },
    { name: "projects", takes: (k) => this.projectsTake(k), handle: (k) => this.projectsKey(k) },
    { name: "menu", takes: () => !!this.menu, handle: (k) => this.menuKey(k) },
    { name: "help", takes: () => this.helpTop !== null, handle: (k) => this.helpKey(k) },
    { name: "questions", takes: (k) => this.questions.takes(k), handle: (k) => this.questions.handle(k).then(() => this.draw()) },
    { name: "escape", takes: (k) => k.name === "escape", handle: () => this.escapeKey() },
    { name: "enter", takes: (k) => k.name === "enter" && !k.shift && !k.alt, handle: () => this.enterKey() },
    { name: "editor", takes: () => true, handle: (k) => { this.edit(k); this.draw(); } },
  ];

  async onKey(k: Key): Promise<void> {
    if (this.canScroll(k)) return this.scroll(k);
    if (k.name === "escape") this.modelGeneration++;
    for (const layer of this.keyLayers) if (layer.takes(k)) return layer.handle(k);
  }

  private canScroll(k: Key): boolean {
    return ["pageup", "pagedown", "wheelup", "wheeldown"].includes(k.name) && !this.keyEcho && !this.menu && !this.projectList && this.helpTop === null && !this.questions.view();
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
    else this.input = { text: "", cursor: 0 };
    return this.draw();
  }

  /** Enter: send the input, dropping blank lines around it but keeping the first line's indent. */
  private enterKey(): Promise<void> | void {
    const text = this.input.text.replace(/^\s*\n/, "").trimEnd();
    if (text !== "/help") this.scrollTop = null;
    this.input = { text: "", cursor: 0 };
    this.historyAt = -1;
    if (!text) return this.draw();
    this.remember(text);
    this.draw();
    return this.submit(text);
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


  /** Track submitted input until onInbox consumes it; a failed write is explicitly reported, never echoed as sent. */
  private async send(page: Page, text: string, submission?: string): Promise<void> {
    const sent = { inputId: crypto.randomUUID(), text };
    page.sent.push(sent);
    this.draw();
    try { await page.orch.say(text, submission, sent.inputId); }
    catch (err) {
      const at = page.sent.indexOf(sent);
      if (at !== -1) page.sent.splice(at, 1);
      this.say(dim(`not sent: ${text}`), page);
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
