import { stat } from "node:fs/promises";
import { workViews } from "../core/data/projects";
import { ConversationSelection, hitRow, Pointer } from "./screen";
import { writeClipboardText, readClipboardImage } from "./components";
import { imageLabels, MAX_IMAGES, pendingImageInputs, saveImage, saveImageInput } from "../core/data/images";
import type { ImageRef } from "../protocol";
import { contextStatus } from "./header";
import { listTasks } from "../core/data/tasks";
import { runningAgentCount, TaskCounts } from "./footer";
import { InputFeedback, compactedNotice } from "./footer";
import { settingChange, effectiveSettings, setEffort } from "../core/data/projects";
// Sticky top and bottom bars around a scrollable conversation. Only changed
// screen rows are redrawn; on exit the active transcript is printed back to
// the terminal's normal scrollback. One page per orchestrator: Ctrl+N starts one named
// orch-xxxx (/rename gives it a display name), Ctrl+Z and Ctrl+X move between
// them, Ctrl+B lists every project (open, pin, delete) on the work page
// (work-page.ts). Type to talk to the page's orchestrator; worker and reviewer reports
// arrive through its inbox and show up while you wait. /help lists the commands.

import { accountChoices, deletionSummary, login, resetProject, useAccount, sendAgentFeedback, restoreConversations } from "./commands";
import { checkContextClear } from "./commands";
import { activeAgentRows, liveAgentsOrNull } from "../core/tmux";
import { directories, displayName, listProjects, newProjectName, remoteOf, setDisplayName, shortRemote } from "../core/data/projects";
import { activeRoles, chooseModel, effortChoices, modelChoices, pageAccount, roleModelsLabel, setModel, switchAllMenu, type Choice, type Scope } from "./commands";
import { paths } from "../config";
import { projectIdentity } from "../core/data/projects";
import { effectiveModel } from "../core/data/projects";
import type { Message } from "../protocol";
import type { Orchestrator } from "../core/agent-loop/orc";
import type { Entry } from "../protocol";
import { format } from "node:util";
import { follow, parts } from "./conversation";
import { editor as ed } from "./footer";
import type { Key } from "./components";
import { historyRows, type Line, type Shown } from "./conversation";
import { appendHistory, keepable, loadHistory, remember, MAX_INPUT_HISTORY } from "./history";
import { MarkdownStream } from "./conversation";
import { helpLines, type CommandHelp } from "./footer";
import { pageQuestions, Questions, QUESTION_DELAY_MS } from "./footer";
import { fromUserLines, replyLines, reportLine, restore, plainToolLine, unresolvedCalls, userLines } from "./conversation";
import { capturedVideos, deliveredImages, openLink, type DeliveredMedia } from "./commands";
import { open } from "../core/data/transcripts";
import { bold, dim, fit, sanitize, repositoryTitle } from "./components";
import { commit, helpPanel, inputArea, inputGeometry, statusRows, type Frame, type Help, type Input, type InputArea } from "./footer";
import type { Terminal } from "./components";
import { shimmer } from "./components";
import { chapterRows, headerHeight } from "./header";
import { captureAnchor, resolveAnchor, type HistoryAnchor } from "./conversation";
import { Calls, collapseCalls, groupStart, groupStarts } from "./conversation";
import type { ToolCall, ToolOutcome } from "../protocol";
import { stickyRows, stickyUpdate, type StickyScreen } from "./screen";

export { helpLines } from "./footer";
export { lineRows, type Line } from "./conversation";

import { type Page, type AppDeps, type ToolEvents, type Clock, realClock, SPINNER, FRAME_MS, RESIZE_MS, SPIN_MS, TICK_MS, LIVE_CHECK_MS, type ActiveMenu, type ClearConfirmation, type Command, parseCommand, type KeyLayer, menuKeyId, active, EDITS, typedText } from './app-state';
import { WorkPages } from "./work-page";
export { type Page, type AppDeps, type ToolEvents, type Clock, AGENTS_TICK_MS, type Command, parseCommand, type KeyLayer } from './app-state';

export class App {
  pages: Page[] = [];
  private modelGeneration = 0;
  private clearing?: ClearConfirmation;
  private _active = 0;
  get active(): number { return this._active; }
  set active(index: number) {
    if (index !== this._active) { this.clipboardGeneration++; this.cancelClear(); this.modelGeneration++; this.helpTop = null; }
    this._active = index; this.work.pageChanged();
    if (this.page) void this.taskCounts.refresh(this.page); // opening or switching to a page reads its task count
  }
  private looseLines: string[] = [];
  input = { text: "", cursor: 0 };
  /** First input row on screen, kept between frames so the input area scrolls only when the cursor leaves it. */
  private inputTop: number | undefined;
  /** Null until explicitly opened; only a footer scroll position, never a history line. */
  private helpTop: number | null = null;
  private readonly taskCounts = new TaskCounts<Page>(page => (this.deps.taskCount ?? this.deps.tasks ?? listTasks)(page.project), page => this.validPage(page), () => this.draw());
  /** The full-screen page of Agents, Tasks, Questions, Images and Projects; it takes every key while open. */
  readonly work: WorkPages;

  private helpContent?: { cols: number; inView: boolean; vim: boolean; lines: string[] };
  menu: ActiveMenu | null = null;
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
      && !page.view && !this.menu && !this.clearing && !this.work.open && this.helpTop === null;
  }
  private async pasteImage(): Promise<void> {
    const page = this.page;
    if (!page || page.view) return this.note(dim("open a project chat before attaching an image."));
    if (this.clipboardReading) return this.note(dim("an image read is already in progress; ctrl+v again when it finishes."));
    if (this.images(page).length >= MAX_IMAGES) return this.note(dim("at most 4 images per prompt; ctrl+y removes the last image."));
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
      if (this.imageOwner(page, generation)) this.note(dim(`image not attached: ${error instanceof Error ? error.message : error}`), page);
    } finally { this.clipboardReading = false; this.draw(); }
  }
  private removeImage(): void {
    const page = this.page;
    if (page && !page.view) this.draftImages.set(page, this.images(page).slice(0, -1));
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
    if (!page || page.view || this.loggingIn) return this.note(dim("open project chat and finish sign-in before retrying images."));
    await this.recoverImages(page);
    for (const item of [...page.sent]) if (item.attachments?.length && item.retry) {
      await this.send(page, item.text, item.submission, item.inputId, item.attachments).catch(error => this.note(dim(String(error)), page));
    }
    this.runTurn(page);
  }
  /** Ctrl+G: echo every key as parsed until Esc, to see what a terminal really sends. */
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
  /** The animation timer's current period. */
  private tickMs = 0;
  private screen: StickyScreen | undefined;
  private screenHistory: string[] = [];
  private screenOwner: Page | Page["view"] | undefined;
  private scrollTop: number | null = null;
  private scrollAnchor?: HistoryAnchor;
  /** A mouse selection temporarily paused tail-following; a click must not pin it forever. */
  private selectionPausedFollow = false;
  private readonly followedInput = new WeakMap<Page, string>();
  private liveCheckedAt = 0;
  /** Liveness checks still running, per project; a tick skips a project while its last check is pending. */
  private readonly liveChecks = new Map<string, Promise<void>>();
  private closed = false;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshForce = false;
  private readonly deferredRefresh = new Set<Page>();
  private readonly renderedHeads = new WeakMap<Page, string | undefined>();
  private readonly refreshedTurns = new WeakSet<Page>();
  /** Pages whose last rendering left out calls the running turn has not finished (they show as running rows instead); re-rendered once the turn ends. */
  private readonly hidRunning = new WeakSet<Page>();
  private readonly notices = new WeakMap<Page, Line[]>();
  /** Reusable page-scoped progress and ephemeral feedback above the composer. */
  private readonly feedback = new InputFeedback<Page>();

  /** The active page's oldest open question in the live region, and the keys it takes (questions.ts). */
  readonly questions: Questions;

  constructor(private readonly deps: AppDeps) {
    this.finished = new Promise<void>((r) => (this.done = r));
    const app = this;
    this.questions = new Questions({
      page: () => app.page,
      valid: page => !app.closed && app.pages.includes(page as Page) && !(page as Page).deleting,
      get input() { return app.input; },
      set input(v) { app.input = { text: v.text, cursor: v.cursor }; },
      say: (line, page) => app.note(line, page as Page),
      note: (text, page) => app.note(text, page as Page),
      queue: (page, inputId, text) => { (page as Page).sent.push({ inputId, text, question: true }); app.draw(); },
      unqueue: (page, inputId) => { const sent = (page as Page).sent; const at = sent.findIndex(m => m.inputId === inputId); if (at !== -1) sent.splice(at, 1); },
      submitted: () => { void app.refreshSessions(); },
      width: () => app.deps.term.cols,
      now: () => app.clock.now(),
      isCommand: (text) => app.commands.has(text.split(" ")[0]!),
      run: (text) => { app.remember(text); return app.submit(text); },
      draw: () => app.draw(),
    }, deps.questions, deps.questionDelayMs ?? QUESTION_DELAY_MS);
    this.work = new WorkPages({
      deps, questions: this.questions, get clock() { return app.clock; },
      page: () => app.page, pages: () => app.pages, valid: page => app.validPage(page),
      draw: () => app.draw(), reprint: () => app.reprint(),
      opening: () => { app.beginMenu(); if (app.vimMode) app.vimMode = "normal"; app.menu = null; app.helpTop = null; },
      input: () => app.input, edit: k => app.edit(k),
      noteRow: page => app.noteRow(page),
      commandLine: () => app.vimCommand, modeTag: () => app.vimMode ? `[${app.vimMode.toUpperCase()}] ` : "",
      images: page => app.imageLists.get(page), readImages: page => app.readImages(page, true), retryImages: page => app.retryImages(page),
      taskCountChanged: page => app.taskCounts.refresh(page),
      attach: (page, name, live) => app.attach(page, name, live),
      openPage: project => app.openPage(project), closePage: index => app.closePage(index), newPage: directory => app.newPage(directory),
    });
  }

  get page(): Page | undefined { return this.pages[this.active]; }

  private get clock(): Clock { return this.deps.clock ?? realClock; }

  /** Run until /quit; opens the given project, or every known one plus the repo we were started in, or a fresh orch-xxxx. */
  async run(project?: string, url?: string): Promise<void> {
    const { term } = this.deps;
    term.open();
    term.setTitle?.(repositoryTitle(this.deps.source ?? process.cwd()));
    const restoreConsole = this.captureConsole();
    term.onKey(k => {
      const send = (key: Key) => { void this.onKey(key).catch(err => this.note(`error: ${err instanceof Error ? err.message : String(err)}`)); };
      // The terminal can deliver several typed keys in one event. Keep paste
      // events intact and pass any text after entering Insert to the editor.
      if (this.vimMode === "normal" && !k.ctrl && !k.alt && k.name === "char" && k.text) {
        let offset = 0;
        for (const char of k.text) {
          if (this.vimMode !== "normal" || this.vimCommand !== undefined) {
            send({ ...k, text: k.text.slice(offset) });
            return;
          }
          send({ ...k, text: char });
          offset += char.length;
        }
      } else send(k);
    });
    term.onResize(() => this.resized());
    const poll = setInterval(() => {
      if (this.page) this.checkLive(this.page.project);
      this.watchPages();
      this.questions.poll(this.pages);
      this.work.poll();
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
      if (this.started) directories.rememberConversations(this.pages.map(p => p.project), this.page?.project);
      this.closed = true;
      for (const t of [this.frameTimer, this.resizeTimer]) if (t) clearTimeout(t);
      this.stopSpinner?.();
      this.stopSpinner = null;
      this.loginAbort.abort();
      // Closing the TUI leaves the orchestrator daemon and its turn running; dispose only stops following.
      for (const p of this.pages) { p.orch.dispose?.(); p.view?.leave(); }
      restoreConsole();
      term.close();
      this.leave();
    }
  }

  /** Open this checkout's conversations, or create its first automatically. */
  private async openStartPages(project?: string, url?: string): Promise<void> {
    await restoreConversations({ project, directory: url, source: this.deps.source,
      open: (id, directory) => this.openPage(id, directory), note: text => this.note(text) });
  }

  /**
   * Route console output (e.g. the config loader's warning) to temporary status
   * feedback while the TUI runs, so nothing writes behind the pinned renderer's
   * back. Returns the undo.
   */
  private captureConsole(): () => void {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => { for (const l of format(...args).split("\n")) this.note(l); };
    return () => methods.forEach((m, i) => { console[m] = saved[i]!; });
  }

  quit(): void { this.work.close(); this.cancelClear(); this.modelGeneration++; this.done(); }

  // --- output -----------------------------------------------------------------

  /** Append a finished line to the page's agent view if one is up, else to the page (or the screen when there is none). */
  say(line: string, page = this.page): void {
    if (!page) { this.looseLines.push(line); this.pending.push(line); return this.draw(); }
    if (page.view) this.toView(page, page.view, [line]);
    else { this.keepNotice(page, line); this.toPage(page, [line]); }
  }

  /**
   * Runtime feedback ("model set to …", a rename, what the daemon
   * keeper did): bounded text above the composer, replacing the page's
   * previous note, never in the conversation or its restored history. Like the
   * project list's status, the next keypress clears it; a mouse event does not.
   */
  note(text: string, page = this.page): void {
    if (Bun.stripANSI(text).trimStart().startsWith("[model request]")) return; // Older daemons still emit lifecycle diagnostics.
    if (page?.orch?.activity?.() && /^(?:compacting older conversation in the background…|orchestrator: compaction requested;)/.test(text.trim())) return;
    this.feedback.set(page, "notice", { content: compactedNotice(text.trim()), lifetime: "ephemeral" });
    this.draw();
  }

  /** The next input key clears the note, even before its queued frame paints; scrolling and mouse selection leave it. */
  private clearNote(k: Key): void {
    if (/^(?:wheel|mouse|page)/.test(k.name)) return;
    this.feedback.dismiss(this.page);
    this.draw();
  }

  /** The shown page's note, cut to one row. Rendering never changes its lifetime. */
  private noteRow(page: Page | undefined): string | undefined {
    return this.feedbackRows(page)[0];
  }
  private feedbackRows(page: Page | undefined): string[] {
    if (page?.orch?.activity?.()?.compacting) this.feedback.set(page, "compaction", { content: "Compacting…", loading: true, lifetime: "persistent" });
    else this.feedback.remove(page, "compaction");
    return this.feedback.rows(page, this.deps.term.cols, this.clock.now());
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
    if (collapseCalls(run).length !== run.length) this.needReprint = true;
    else this.pending.push(...this.rows(lines, previous));
  }

  /** Groups a click opened, by the start index of their run, per history (a page's or a view's lines); a new history (syncTranscript) carries them over by order. */
  private readonly openGroups = new WeakMap<readonly Line[], Set<number>>();

  /** The lines a page shows (its agent view's, else its own): runs of finished calls folded into one line each, the clicked-open ones with their calls under it; `all` leaves every call as it is (the quit replay). */
  private shown(page: Page, lines = page.view?.lines ?? page.lines, all = false): readonly Shown[] {
    return all ? lines : collapseCalls(lines, this.openGroups.get(lines));
  }

  /** What the screen shows for the active page: its agent view or its history. */
  private screenLines(page = this.page): string[] {
    return page ? this.rows(this.shown(page)) : this.looseLines;
  }

  /** History lines laid out at the terminal's width. */
  private rows(lines: readonly Shown[], previous?: Shown): string[] {
    return historyRows(lines, this.deps.term.cols, previous);
  }

  /** Model text and legacy tool output remain in conversation; runtime status uses the footer. */
  private stream(page: Page, text: string, plain = false): void {
    if (plain && !plainToolLine(text)) return this.note(text, page);
    page.streamed = true;
    if (!plain) return this.toPage(page, page.md.feedLines(text));
    this.endPartial(page);
    this.toPage(page, text.replace(/\n$/, "").split("\n"));
  }

  /** Consumption is the only normal path from a queued prompt to conversation history. */
  private inbox(page: Page, msgs: Message[]): void {
    this.followIncoming(page, msgs);
    this.endPartial(page);
    for (const m of msgs) {
      if (m.from !== "user") { this.toPage(page, [reportLine(m.from, m.text)]); continue; }
      // Match identity, not text: an identical external message is not an acknowledgement.
      // Typed here: show only now, at the consumption boundary (answer-shaped chat stays chat).
      // A question answered here leaves the queue the same way; settled questions leave no line.
      const at = m.inputId ? page.sent.findIndex(item => item.inputId === m.inputId) : -1;
      const item = at === -1 ? undefined : page.sent.splice(at, 1)[0];
      if (item && !item.question) { this.toPage(page, userLines([m.text, imageLabels(m.attachments)].filter(Boolean).join("\n"))); continue; }
      // Anything else from elsewhere (`orca msg`) as "> …", a question's answer as nothing: as restore shows them.
      this.toPage(page, fromUserLines([m.text, imageLabels(m.attachments)].filter(Boolean).join("\n")));
    }
  }

  /** New external input starts fresh activity. Local queued-prompt acknowledgements
   * and continuing output preserve an intentional scroll through the current turn. */
  private followIncoming(page: Page, messages: readonly Message[]): void {
    const incoming = messages.findLast(message => message.from !== "user" || !message.inputId || !page.sent.some(sent => sent.inputId === message.inputId));
    if (!incoming) return;
    const key = JSON.stringify([incoming.from, incoming.inputId ?? incoming.event?.id, incoming.ts, incoming.text]);
    if (this.followedInput.get(page) === key) return;
    this.followedInput.set(page, key); // Live notification and durable refresh describe the same delivery.
    if (page !== this.page || page.view || this.selection.active) return;
    this.scrollTop = null;
    this.scrollAnchor = undefined;
    this.selectionPausedFollow = false;
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
  }

  frame(): Frame {
    const page = this.page;
    const status = this.started && page ? this.status(page) : null;
    const refs = this.images(page);
    const showImages = refs.length > 0;
    const prefix = "/" + (this.vimCommand ?? "").replace(/^\//, "");
    const matches = this.vimCommand !== undefined && !prefix.includes(" ")
      ? [...this.commands.keys()].filter(name => name.startsWith(prefix)).slice(0, 5) : [];
    const notes = [...this.feedbackRows(page), ...(this.vimCommand !== undefined ? [fit(sanitize(`:${this.vimCommand} ▏ ${matches.join("  ")}`), this.deps.term.cols)] : [])];
    const { input, area } = this.inputFrame(statusRows(status, this.deps.term.cols, this.composerRows()).length + (showImages ? 1 : 0) + notes.length);
    if (showImages) {
      area.lines.unshift(dim(`${imageLabels(refs)} · ctrl+y remove last`.slice(0, this.deps.term.cols)));
      area.row++;
    }
    area.lines.unshift(...notes); area.row += notes.length;
    return {
      cols: this.deps.term.cols, rows: this.deps.term.rows,
      partial: page && !page.view ? page.md.pending : "",
      running: page ? (page.view?.calls ?? page.calls).rows(this.clock.now(), this.deps.term.cols) : [],
      activity: !this.started ? dim("opening…") : page ? this.activity(page) : undefined,
      welcome: this.started && !!page && this.newChat(page),
      status, input, inputArea: area,
      // Project-owned submitted text only: never reconstruct from conversation
      // user lines or from the chat/answer draft. This is presentation, not delivery.
      queued: page ? { project: page.name, texts: [...page.sent.map(item => `${item.retry ? "[not confirmed; t on the Images page retries] " : ""}${item.text}${item.attachments?.length ? " " + imageLabels(item.attachments) : ""}`), ...(this.queued.get(page) ?? []).map(item => `${item.text}${item.attachments?.length ? " " + imageLabels(item.attachments) : ""}`)] } : undefined,
      menu: this.menu,
      help: this.helpView(),
      question: this.questions.view(),
    };
  }

  private header(page: Page, decorate = true): string[] {
    const directory = paths.repo(page.project); this.deps.term.setTitle?.(repositoryTitle(directory));
    const settings = page.settings;
    const model = `${page.model ? roleModelsLabel(page.model, page.roles) : "loading model…"} · effort ${settings ? settings.effort ?? "default" : "…"} · fast ${settings ? settings.fast ? "on" : "off" : "…"}`;
    const lines = chapterRows({ tabs: this.pages, active: this.pages.indexOf(page), account: page.account, model, context: this.contextLabel(page), directory, remote: page.remote ? shortRemote(page.remote) : "no remote", agent: page.view?.name, fin: decorate && !this.newChat(page) ? { time: this.clock.now(), active: page.view ? page.view.live : page.busy } : undefined }, this.deps.term.cols, headerHeight(this.deps.term.rows));
    return lines;
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
    const [settings, account] = await Promise.all([effectiveSettings(page.project, model).catch(() => undefined), pageAccount(page.project)]);
    if (this.modelVersions.get(page) !== version || !this.pages.includes(page) || page.deleting) return;
    const roles = activeRoles(page.project, model);
    const unchanged = model === page.model && account === page.account && JSON.stringify(settings) === JSON.stringify(page.settings) && JSON.stringify(roles) === JSON.stringify(page.roles);
    page.model = model; page.roles = roles; page.account = account;
    page.settings = settings;
    if (!unchanged && page === this.page) this.draw();
  }

  /** Agent views show no session context; otherwise the orchestrator's own compaction limit. */
  private contextLabel(page: Page): string {
    const model = page.roles?.orchestrator ?? page.model; // the orchestrator's own model, its /model override if set
    if (page.view || !model) return contextStatus(undefined);
    return contextStatus(model, page.orch.contextUsage?.(model), page.orch.contextWindow?.(model));
  }

  private spinner(): string { return SPINNER[Math.floor(this.clock.now() / SPIN_MS) % SPINNER.length]!; }

  /** Counts only: no shortcuts, repeated identities or transient animation in the footer. */
  status(page: Page): string {
    const questions = page.questions.loaded && !page.questions.error ? page.questions.open.length : "?";
    const images = this.imageLists.get(page);
    return `${page.agentCount ?? "?"} agents | ${this.taskCounts.label(page)} | ${questions} questions | ${images?.count ?? "?"} ${images?.rows.some(row => row.kind === "video") ? "media" : "images"}`;
  }

  /** Only the selected conversation can animate; tool rows already carry their own shimmer. */
  activity(page: Page): string | undefined {
    if ((page.view?.calls ?? page.calls).size) return undefined;
    if (page.view) return page.view.live ? dim(`${this.spinner()} ${shimmer("working…", this.clock.now())}`) : undefined;
    return page.busy && page.orch.activity?.()?.working !== false ? dim(this.turnStatus(page)) : undefined;
  }

  /** Fast frames only for visible animation, never because a background page is busy. */
  private shimmering(): boolean {
    const page = this.page;
    return !!page && (!!(page.view?.calls ?? page.calls).size || !!this.activity(page));
  }

  /** "⠋ thinking… 3s" with the word shimmering; the surrounding dim resumes after it. */
  private turnStatus(page: Page): string {
    const now = this.clock.now();
    const word = shimmer(page.streamed ? "working…" : page.sent.some(item => !item.retry) ? "queued…" : "thinking…", now);
    return `${this.spinner()} ${word}\x1b[2m ${Math.floor((now - page.busySince) / 1000)}s`;
  }

  /** Run the spinner timer only while some page is busy or viewing a live agent. */
  private animate(): void {
    const fast = this.shimmering();
    const ms = fast ? TICK_MS : SPIN_MS;
    const want = !this.closed && (fast || this.pages.some(active) || !!this.page?.orch.activity?.()?.compacting);
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
    const agents = this.deps.agents ?? activeAgentRows;
    const check = agents(project)
      .then((agents) => {
        const live = new Set(agents.filter((a) => a.live).map((a) => a.name));
        const count = runningAgentCount(agents);
        for (const p of this.pages) if (p.project === project) p.agentCount = count;
        this.draw();
        for (const p of this.pages) if (p.project === project && p.view?.live && !agents.some(a => a.name === p.view!.name && a.status === "unknown") && !live.has(p.view.name)) { p.view.live = false; this.draw(); }
      })
      .catch(() => { for (const p of this.pages) if (p.project === project) p.agentCount = undefined; this.draw(); })
      .finally(() => this.liveChecks.delete(project));
    this.liveChecks.set(project, check);
  }

  /** The input and its laid-out area, keeping the window's top row between frames. */
  private inputFrame(reserved: number): { input: Input; area: InputArea } {
    const input: Input = { prompt: this.prompt(), text: this.input.text, cursor: this.input.cursor, top: this.inputTop, mode: this.vimMode };
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
    this.clearSelection();
    if (this.closed) return;
    this.cancelClear();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.reprint(); }, RESIZE_MS);
  }

  private flush(): void {
    this.lastFrame = Date.now();
    try {
      this.questions.sync(); // the input holds the chat draft or the shown question's answer
      const next = this.work.open ? this.work.screen() : this.viewport(this.frame());
      this.pointer.frame.paint(next.rows, next.cols);
      const output = stickyUpdate(next, this.screen);
      if (!this.work.open) this.needReprint = false;
      // Synchronized output, so the terminal shows the whole update at once.
      if (output) this.deps.term.write(`\x1b[?2026h${output}\x1b[?2026l`);
      this.screen = next;
      this.deps.term.eraseOnExit("");
    } catch (err) {
      // A bad frame must not take the app down. Its lines are still in the page's history; say so once and reprint next time.
      const note = `error drawing the screen: ${err instanceof Error ? err.message : String(err)}`;
      this.screen = undefined;
      if (this.started) this.needReprint = true;
      if (note !== this.drawError) { this.drawError = note; this.note(dim(note)); }
    }
  }

  private readonly selection = new ConversationSelection();

  private clearSelection(): void {
    this.selection.clear();
    if (this.selectionPausedFollow) {
      this.scrollTop = null;
      this.scrollAnchor = undefined;
      this.selectionPausedFollow = false;
    }
  }

  private selectionAllowed(): boolean {
    return !this.clearing && !this.keyEcho && !this.menu && this.helpTop === null && !this.work.open;
  }

  private validateSelection(owner: typeof this.screenOwner, cols: number): void {
    if (!this.selectionAllowed() || owner !== this.screenOwner || this.screen?.cols !== cols) this.clearSelection();
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
    // Folded groups cannot be opened once the TUI is gone: the scrollback gets every call.
    const history = page ? this.shown(page, undefined, true) : this.looseLines;
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
        ]);
        if (forced) await this.work.refresh("projects");
        await this.refreshTaskViews(this.page, forced);
      } while (this.refreshAgain && !this.closed);
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private validPage(page: Page): boolean {
    return !this.closed && !page.deleting && this.pages.includes(page);
  }

  private readonly metadataAt = new WeakMap<Page, number>();

  private async refreshPage(page: Page, forced: boolean): Promise<void> {
    if (!this.validPage(page)) return;
    const nameBefore = page.name, remoteBefore = page.remote;
    const now = this.clock.now();
    const metadataDue = forced || now - (this.metadataAt.get(page) ?? -Infinity) >= 30_000;
    const safe: Promise<unknown>[] = [];
    if (metadataDue) {
      this.metadataAt.set(page, now);
      safe.push(this.refreshHeader(page),
        displayName(page.project).then(name => { if (this.validPage(page) && page.name === nameBefore) page.name = name; }));
    }
    if (forced) safe.push(this.questions.refresh(page),
      remoteOf(page.project).then(remote => { if (this.validPage(page) && page.remote === remoteBefore) page.remote = remote; }));
    this.checkLive(page.project);
    const results = await Promise.allSettled(safe);
    try {
      if (page.busy) this.deferredRefresh.add(page);
      else if (await page.orch.refresh?.() === false || page.busy) this.deferredRefresh.add(page);
      else if (this.validPage(page)) {
        this.deferredRefresh.delete(page);
        this.syncTranscript(page);
        if (forced || page.sent.length) await this.recoverImages(page);
      }
      if (metadataDue) {
        // Don't overwrite a history append/recall that raced the read.
        const before = page.inputHistory, writing = page.savingHistory;
        await writing;
        const saved = await loadHistory(page.project);
        if (this.validPage(page) && page.inputHistory === before && page.savingHistory === writing && this.historyAt === -1) {
          page.inputHistory = [...saved.entries, ...before.filter(text => !saved.entries.includes(text))].slice(-MAX_INPUT_HISTORY);
          page.historyLines = saved.lines;
        }
      }
      const failed = results.find(r => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      if (this.validPage(page)) this.note(dim(`refresh failed (input retained): ${error instanceof Error ? error.message : String(error)}`), page);
    }
    this.draw();
  }

  /** Only durable exact IDs acknowledge pending input. Re-rendering saved tool
   * entries is presentation, never tool execution. Called idle, pre-stream, or
   * mid-turn by a daemon client when an entry lands: the durable entries then
   * supersede what the live events showed, so the stream's partial text and
   * running calls are dropped with the old rendering (the events still ahead of
   * the record follow again through the same hooks). */
  private syncTranscript(page: Page, running = page.busy): void {
    const consumed = page.orch.consumed?.();
    const entries = page.orch.entries?.();
    if (!entries) {
      if (consumed) page.sent = page.sent.filter(m => !consumed.has(m.inputId));
      return;
    }
    const head = entries.at(-1)?.uuid;
    const previous = this.renderedHeads.get(page);
    if (previous && previous !== head) {
      const at = entries.findLastIndex(entry => entry.uuid === previous);
      // Startup/replay is not new activity; only entries appended after the rendered head count.
      if (at !== -1) this.followIncoming(page, entries.slice(at + 1).flatMap(entry => entry.type === "message" && !entry.contextSnapshot ? entry.inbox ?? [] : []));
    }
    if (consumed) page.sent = page.sent.filter(m => !consumed.has(m.inputId));
    this.updateImages(page, entries);
    if (this.renderedHeads.get(page) === head) return;
    const boundary = entries.findLast(entry => entry.type === "context-boundary")?.uuid, cleared = boundary !== page.contextBoundary;
    page.contextBoundary = boundary;
    if (cleared) {
      this.notices.delete(page); this.feedback.clear(page); this.openGroups.delete(page.lines);
      if (page === this.page && !page.view) {
        this.pending = []; this.screenHistory = []; this.scrollTop = null; this.scrollAnchor = undefined; this.clearSelection();
      }
    }
    // Status is a live event, never restored from saved metadata or re-emitted by refresh.
    page.md.reset(); page.calls.clear();
    const lines = this.restored(page, entries, running);
    // Keep local diagnostics, but don't duplicate what the record holds.
    const saved = new Set(lines.map(line => JSON.stringify(line)));
    const notes = (this.notices.get(page) ?? []).filter(line => !saved.has(JSON.stringify(line)));
    this.notices.set(page, notes);
    const next = [...lines, ...notes];
    if (!cleared) this.carryOpen(page.lines, next);
    const anchor = this.relocatedAnchor(page, next);
    page.lines = next;
    if (anchor) { this.scrollAnchor = anchor; this.scrollTop = resolveAnchor(this.shown(page), this.deps.term.cols, anchor); }
    this.renderedHeads.set(page, head);
    if (page === this.page && !page.view) this.reprint();
  }

  /** The groups opened in `from` stay open in `to`, its re-rendering: the same group is the same run in order. */
  private carryOpen(from: readonly Line[], to: readonly Line[]): void {
    const open = this.openGroups.get(from);
    if (!open?.size) return;
    const starts = groupStarts(to);
    this.openGroups.set(to, new Set(groupStarts(from).flatMap((start, i) => open.has(start) && starts[i] !== undefined ? [starts[i]!] : [])));
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
  private restored(page: Page, entries: Entry[], running: boolean): Line[] {
    const omit = running ? unresolvedCalls(entries) : undefined;
    if (omit?.size) this.hidRunning.add(page); else this.hidRunning.delete(page);
    return restore(entries, this.deps.term.cols, Infinity, omit);
  }

  async openPage(project: string, url?: string): Promise<Page> {
    this.clipboardGeneration++;
    this.modelGeneration++;
    const existing = this.pages.findIndex((p) => p.project === project);
    if (existing !== -1) {
      if (existing !== this.active) { this.active = existing; this.reprint(); }
      return this.pages[existing]!;
    }
    const page: Page = { project, name: project, orch: null as unknown as Orchestrator, remote: "", lines: [], md: new MarkdownStream(), busy: false, busySince: 0, streamed: false, inputHistory: [], historyLines: 0, savingHistory: Promise.resolve(), sent: [], questions: pageQuestions(), view: null, calls: new Calls() };
    // Runtime status belongs above the input, including failures and aborted requests.
    const tools: ToolEvents = { onRefresh: () => { this.syncTranscript(page); this.refreshedTurns.add(page); this.draw(); }, onTool: (call) => this.toolStarted(page, call), onToolResult: (outcome) => this.toPage(page, [page.calls.finish(outcome)]), notice: text => this.note(text, page) };
    page.orch = await this.deps.openOrchestrator(project, url, (text, plain) => this.stream(page, text, plain), (msgs) => this.inbox(page, msgs), tools);
    // Like `claude --continue`: the page starts with what its transcript showed live (from the transcript the orchestrator loaded), and ↑ recalls what was typed.
    // A turn already running elsewhere (the daemon's) shows its unfinished calls live, not as interrupted.
    this.syncTranscript(page, await page.orch.pending().catch(() => false));
    this.renderedHeads.set(page, page.orch.entries?.().at(-1)?.uuid);
    const saved = await loadHistory(project);
    if (!this.imageLists.has(page)) {
      try { await this.readImages(page); }
      catch { /* The footer shows an unknown count. Opening Images reports the read error. */ }
    }
    page.inputHistory = saved.entries;
    page.historyLines = saved.lines;
    page.remote = await remoteOf(project);
    page.name = await displayName(project);
    this.notices.set(page, [...this.looseLines]);
    page.lines.unshift(...this.looseLines);
    this.looseLines = [];
    this.feedback.move(undefined, page);
    page.model = await this.readModel(project); page.roles = activeRoles(project, page.model); page.account = await pageAccount(project);
    page.settings = await effectiveSettings(project, page.model).catch(() => undefined);
    try { page.sent.push(...(await pendingImageInputs(project, page.orch.consumed?.())).map(input => ({ ...input, retry: true }))); }
    catch (error) { this.note(dim(`image recovery failed: ${error}`), page); }
    this.pages.push(page);
    this.active = this.pages.length - 1;
    directories.attachConversation(project); // Opening is observation; only fresh input starts execution.
    this.checkLive(project);
    this.questions.poll([page]);
    this.reprint();
    void this.work.refresh("projects");
    return page;
  }

  closePage(index = this.active): void {
    this.clipboardGeneration++;
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
    this.work.pageChanged();
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

  /** Start a conversation in the given local directory, else the current page's checkout, else the launch checkout. */
  async newPage(url?: string): Promise<void> {
    const shown = await this.shownNames();
    try {
      const page = await this.openPage(newProjectName([...shown.keys(), ...shown.values()]), url ?? (this.page ? paths.repo(this.page.project) : this.deps.source) ?? undefined);
      this.note("/rename <name> to rename", page);
    } catch (err) { this.note(`error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Set the page's display name; the project folder, id and running agents are untouched, so this works mid-turn. */
  async renamePage(to: string): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (!to) return this.note(dim("usage: /rename <name>"));
    if (this.pages.some((p) => p !== page && (p.name === to.trim() || p.project === to.trim()))) return this.note(dim(`another page is already called ${to.trim()}`));
    try {
      const from = page.name;
      page.name = await setDisplayName(page.project, to);
      this.note(`${from} → ${page.name}`, page);
      await this.work.refresh("projects");
    } catch (err) { this.note(`error: ${err instanceof Error ? err.message : String(err)}`, page); }
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
        this.toPage(page, replyLines(reply));
      }
    } catch (err) {
      failed = true;
      this.endPartial(page);
      this.note(`${bold("error")} ${err instanceof Error ? err.message : String(err)}; turn stopped. send another message to resume with retained history; changing model alone does not retry. exited agents require restart.`, page);
    } finally { this.endTurn(page, failed); }
  }

  /** A failed turn's lines that the record does not hold stay on the page as notices. */
  private keepUnsaved(page: Page): void {
    const saved = restore(page.orch.entries?.() ?? [], this.deps.term.cols, Infinity);
    const known = new Set([...saved, ...(this.notices.get(page) ?? [])].map(line => JSON.stringify(line)));
    for (const line of page.lines) if (!known.has(JSON.stringify(line))) this.keepNotice(page, line);
  }

  /** The turn is over: settle what it showed, keep a failed turn's lines as notices, and show the record's view of what it left running. */
  private endTurn(page: Page, failed: boolean): void {
    this.endPartial(page);
    page.busy = false;
    const entries = page.orch.entries?.();
    if (entries) this.updateImages(page, entries);
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

  private readonly imageLists = new WeakMap<Page, { head?: string; rows: DeliveredMedia[]; archived: Record<string, boolean>; count: number }>();

  private async readImages(page: Page, includeVideos = false): Promise<void> {
    const path = paths.transcript(page.project, "orchestrator");
    const transcript = await Bun.file(path).exists() ? open(path) : undefined;
    this.updateImages(page, transcript ? transcript.history?.() ?? transcript.branch() : []);
    const videos = includeVideos ? await capturedVideos(page.project) : undefined;
    const list = this.imageLists.get(page)!;
    if (videos) list.rows = [...list.rows.filter(row => row.kind === "image"), ...videos].sort((a, b) => b.at.localeCompare(a.at));
    list.archived = workViews.workArchive(page.project, "images");
    list.count = list.rows.filter(media => !(list.archived[media.id] ?? media.archived)).length;
  }

  private updateImages(page: Page, entries: readonly Entry[]): void {
    const head = entries.at(-1)?.uuid;
    const previous = this.imageLists.get(page);
    if (previous && previous.head === head) return;
    const rows: DeliveredMedia[] = [...deliveredImages(entries).map(image => ({ ...image, kind: "image" as const, id: image.ref.id })),
      ...(previous?.rows.filter(row => row.kind === "video") ?? [])];
    rows.sort((a, b) => b.at.localeCompare(a.at));
    const archived = workViews.workArchive(page.project, "images");
    this.imageLists.set(page, { head, rows, archived, count: rows.filter(media => !(archived[media.id] ?? media.archived)).length });
  }

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

  /** What opening any menu first closes or invalidates. */
  private beginMenu(modelOperation?: number): void {
    this.clipboardGeneration++;
    this.work.close();
    this.cancelClear();
    if (modelOperation === undefined) this.modelGeneration++;
  }

  private showMenu(menu: ActiveMenu): void {
    if (this.vimMode) this.vimMode = "normal";
    this.helpTop = null;
    this.menu = menu;
    this.draw();
  }

  private async accountsMenu(page?: Page): Promise<void> {
    this.modelGeneration++;
    if (!page) return this.note(dim("open a project before choosing its account"));
    const identity = projectIdentity(page.project);
    this.openMenu("accounts: enter uses one for this project or signs it in", await accountChoices(dim, page.project), async (account) => {
      if (!account.ok) return this.login(`${account.provider} ${account.profile}`, page, true);
      this.note(await useAccount(account, page.project, identity).catch((err: unknown) => dim(err instanceof Error ? err.message : String(err))), page); await this.refreshHeader(page);
    });
  }

  private async attach(page: Page, name: string, live: boolean): Promise<void> {
    this.cancelClear();
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r, live, calls: new Calls() }));
    const view = page.view!;
    if (page === this.page) this.reprint();
    this.note(dim("esc returns"), page);
    await follow(paths.transcript(page.project, name), (_s, entry) => this.toView(page, view, view.calls.absorb(parts(entry) ?? [])), stopped, 300, () => { if (!view.live) this.toView(page, view, view.calls.interrupt()); }, text => this.note(text, page));
    if (page.view === view) {
      page.view = null;
      if (page === this.page) this.reprint();
    }
    this.draw();
  }

  /** Run injected watchers and refresh the task views when a watcher finishes. */
  private watchPages(): void {
    const watchers = [this.deps.watchdog, this.deps.merges].filter((w): w is NonNullable<typeof w> => !!w);
    for (const p of this.pages) {
      if (this.authorizedPages.has(p)) void this.keepDaemon(p.project, p);
      if (watchers.length) void Promise.all(watchers.map(w => w(p.project).catch(() => {}))).then(() => this.refreshTaskViews(p));
    }
  }

  /** Start the project's orchestrator daemon when none is alive: what it did or why it could not, as temporary feedback. */
  private async ensureDaemon(project: string): Promise<{ line: string; failed: boolean } | undefined> {
    if (!this.deps.ensureDaemon) return;
    try { const line = await this.deps.ensureDaemon(project); return line ? { line, failed: false } : undefined; }
    catch (error) { return { line: `orchestrator unavailable: ${error instanceof Error ? error.message : String(error)}`, failed: true }; }
  }
  /** A repeated failure (a start that keeps failing) is shown once, not once per poll; every (rate-limited) start or restart is noted. */
  private readonly daemonLines = new WeakMap<Page, string>();
  private readonly authorizedPages = new WeakSet<Page>();
  private async keepDaemon(project: string, page: Page): Promise<void> {
    const outcome = await this.ensureDaemon(project);
    if (!outcome || !this.validPage(page)) return;
    if (!outcome.failed) { this.daemonLines.delete(page); return this.note(outcome.line, page); }
    if (this.daemonLines.get(page) === outcome.line) return;
    this.daemonLines.set(page, outcome.line);
    this.note(dim(outcome.line), page);
  }

  /** Start a turn on every idle page whose orchestrator has unread messages. */
  private runPending(): void {
    for (const p of this.pages) if (!p.busy && !p.deleting) p.orch.pending().then((has) => { if (has) this.runTurn(p); }).catch(() => {});
  }

  private async login(arg: string, page?: Page, select = false): Promise<void> {
    if (this.loggingIn) return this.note(dim("already signing in; /quit cancels"));
    this.loggingIn = true;
    this.note(dim("signing in… (/quit cancels)"));
    let ok = false;
    try {
      const result = await (this.deps.login ?? login)(arg, { write: (s) => this.note(s.replace(/\n$/, "")), signal: this.loginAbort.signal }, page && { name: page.project, select });
      ok = !result.startsWith("usage:");
      this.note(result);
    } catch (err) { this.note(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
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
    const failure = texts.some(m => m.attachments?.length) ? "sign-in failed; image prompts retained (t on the Images page retries)" : `sign-in failed; dropped ${texts.length} queued message(s)`;
    while (texts.length) {
      const { text, submission, inputId, attachments } = texts.shift()!; // ownership transfers to send (Page.sent), or an explicit drop report
      if (ok && this.pages.includes(page)) await this.send(page, text, submission, inputId, attachments).catch(() => {});
      else {
        if (attachments?.length) page.sent.push({ text, submission, inputId, attachments, retry: true });
        this.note(dim(`not sent after sign-in (${page.name}): ${text}${imageLabels(attachments)}${attachments?.length ? "; retry on the Images page" : ""}`), this.pages.includes(page) ? page : this.page);
      }
    }
    if (!ok) this.note(failure, this.pages.includes(page) ? page : this.page);
    if (!texts.length && this.queued.get(page) === texts) this.queued.delete(page);
  }

  // --- input ------------------------------------------------------------------

  /**
   * The slash commands, by name. Every one works at any time: mid-turn, while
   * viewing an agent and while signing in (a second /login is refused by
   * login() itself). Table order is the order within a /help group.
   */
  readonly commands: ReadonlyMap<string, Command> = new Map<string, Command>([
    ["/vim", { run: () => {
      this.vimMode = this.vimMode ? undefined : "normal"; this.vimPrefix = undefined; this.draw();
    }, help: { group: "conversation", label: "/vim", description: "toggle Vim navigation and editing modes" } }],
    ["/rename", { args: true, run: (args) => this.renamePage(args), help: { group: "projects", label: "/rename <name>", description: "rename conversation and its folder link; keep its identity" } }],
    ["/quit", { run: () => this.quit(), help: { group: "projects", label: "/quit", description: "exit; keep conversation history" } }],
    ["/effort", { args: true, run: (args, page) => args ? this.requestSetting(page, args, "effort") : this.effortMenu(page), help: { group: "settings", label: "/effort [level|default]", description: "choose or set project/model reasoning effort" } }],
    ["/fast", { args: true, run: (args, page) => this.requestSetting(page, args, "fast"), help: { group: "settings", label: "/fast [on|off]", description: "show or set project/model fast mode" } }],
    ["/clear-context", { run: (_, page) => this.clearCommand(page), help: { group: "conversation", label: "/clear-context", description: "reset the project: history, tasks and agents go" } }],
    ["/compact", { needsPage: true, run: async (_, page) => { await page!.orch.compact?.(); }, help: { group: "advanced", label: "/compact", description: "summarize model context; keep full history" } }],
    ["/model", { args: true, run: (args, page) => this.modelCommand(args, page), help: { group: "settings", label: "/model [orch|worker|reviewer]", description: "choose the model for all agents or one role" } }],
    ["/accounts", { run: (_, page) => this.accountsMenu(page), help: { group: "settings", label: "/accounts", description: "choose a subscription account" } }],
    ["/login", { args: true, run: (args, page) => this.login(args, page), help: { group: "settings", label: "/login claude|codex [profile]", description: "sign in to a subscription account" } }],
    ["/help", { run: () => this.toggleHelp(), help: { group: "conversation", label: "/help", description: "commands and keyboard shortcuts; esc closes" } }],
  ]);

  /** The context reset asks first, and never submits a prompt. */
  private async clearCommand(page?: Page): Promise<void> {
    this.cancelClear();
    if (!page) return this.note(dim("open a project before clearing context"));
    let operation: ClearConfirmation | undefined;
    try {
      this.checkClearPage(page);
      operation = { page, identity: projectIdentity(page.project), controller: new AbortController() };
      this.clearing = operation;
      await page.orch.checkClear!();
      if (!this.clearCurrent(operation)) return;
      this.checkClearPage(page);
      const losing = await deletionSummary({ name: page.project }).then(text => { operation!.discard = true; return text; }, () => "");
      this.helpTop = null; this.work.close();
      this.menu = operation.menu = {
        title: dim(`clear ${page.name}? removes its history${losing ? `, ${losing}` : ""}; name, folder and settings stay. ↑↓ enter · esc`),
        items: ["cancel", "clear context"], index: 0,
        pick: index => { if (index === 1) return this.confirmClear(operation!); this.cancelClear(); this.draw(); },
      };
      this.draw();
    } catch (error) {
      if (!operation || this.clearCurrent(operation)) {
        this.cancelClear();
        this.note(dim(`cannot clear: ${error instanceof Error ? error.message : error}`), page);
      }
    }
  }

  private checkClearPage(page: Page): void { checkContextClear(page, this.page, this.pages, this.queued.get(page)); }

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
      this.checkClearPage(page); await page.orch.checkClear!(); // Input may have landed since the question opened.
      if (projectIdentity(page.project) !== operation.identity) throw new Error("project changed; reopen it before clearing context");
      // The project as if just created (commands/project.ts): its page closes once the checks pass and reopens in the same tab.
      const at = this.pages.indexOf(page), draft = this.input;
      await (this.deps.resetProject ?? resetProject)(page.project, { ...this.deps.projects, discard: operation.discard, beforeRemove: () => { if (!this.clearCurrent(operation)) throw new Error("you moved to another page"); this.closePage(at); } });
      const fresh = await this.openPage(page.project);
      this.pages.splice(at, 0, ...this.pages.splice(this.pages.indexOf(fresh), 1)); this.active = at; this.input = draft;
      this.note("cleared: history, tasks, questions, images and agents removed.", fresh);
    } catch (error) {
      this.note(dim(`cannot clear: ${error instanceof Error ? error.message : error}`), this.pages.includes(page) ? page : this.page);
    } finally {
      if (this.clearing === operation) this.cancelClear();
      this.draw();
    }
  }

  /** Own all typing/paste/question keys, even when a tiny footer hides the modal.
   * Navigation cancels first; Enter only confirms after an explicit plain arrow selection. */
  private clearKey(k: Key): Promise<void> | void {
    if (k.ctrl && k.name === "c") { this.cancelClear(); return this.interrupt(); }
    if (k.name === "escape") { this.cancelClear(); return this.draw(); }
    if (k.ctrl && ["n", "z", "x", "b"].includes(k.name)) { this.cancelClear(); return this.onKey(k); }
    const operation = this.clearing!;
    if (operation.committing || !operation.menu || k.ctrl || k.alt || k.shift) return;
    const menu = operation.menu;
    if (k.name === "home") menu.index = 0;
    if (k.name === "end") menu.index = 1;
    if (k.name === "up" || k.name === "down") menu.index = 1 - menu.index;
    if (k.name === "enter") {
      if (menu.index === 1) return this.confirmClear(operation);
      this.cancelClear();
    }
    this.draw();
  }

  /** /effort <level|default>, /fast [on|off]: a report saves nothing; a change is validated, then confirmed like /model. */
  private async requestSetting(page: Page | undefined, args: string, setting: "effort" | "fast"): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.note(dim("open a project before changing its model settings"));
    const change = await settingChange(page.project, setting, args);
    return typeof change === "string" ? this.note(change, page) : this.saveSetting(page, operation, `set ${setting} for ${change.model} to ${change.value}?`, change.save);
  }

  /** A confirmed /effort or /fast save: its result or refusal is a note on the captured page. */
  private saveSetting(page: Page, operation: number, question: string, save: () => Promise<string>): Promise<void> {
    return this.confirmAll(page, operation, question, async () => {
      if (!this.modelPageCurrent(page, operation)) return;
      this.note(await save().catch((err) => dim(err instanceof Error ? err.message : String(err))), page);
      await this.refreshHeader(page);
    });
  }

  /** /effort opens the picker for the project's current model; it saves for exactly that model. */
  private async effortMenu(page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.note(dim("open a project before changing its model settings"));
    const identity = projectIdentity(page.project);
    this.note("fetching effort levels…", page);
    let picker: Awaited<ReturnType<typeof effortChoices>>;
    try { picker = await (this.deps.effortChoices ?? effortChoices)(page.project); }
    catch (err) { this.feedback.clear(page); return this.note(dim(err instanceof Error ? err.message : String(err)), page); }
    if (this.feedback.clear(page)) this.draw();
    if (!this.modelPageCurrent(page, operation)) return;
    if (picker.note) this.note(picker.note, page);
    this.openMenu(`effort for ${picker.model}   (/effort <level|default> sets directly)`, picker.choices, (level) => this.saveSetting(page, operation, `set effort for ${picker.model} to ${level}?`, () => setEffort(page.project, picker.model, level, identity)), operation);
  }

  /** /model [orch|worker|reviewer]: the scope step, then the picker of the project's account's models (commands/model-flow.ts); no id argument. */
  private async modelCommand(args: string, page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.note(dim("open a project before changing its model"));
    const { project } = page, identity = projectIdentity(project);
    await chooseModel(args, {
      project, identity, dim,
      current: () => this.modelPageCurrent(page, operation),
      note: (text) => this.note(text, page),
      unnote: () => { if (this.feedback.clear(page)) this.draw(); },
      open: (title, choices, pick) => this.openMenu(title, choices, pick, operation),
      confirm: (question, scope, save) => this.confirmAll(page, operation, question, save, scope),
      projectModel: () => this.readModel(project),
      choices: () => (this.deps.modelChoices ?? modelChoices)(dim, project),
      saveAll: (id) => (this.deps.saveModel ?? setModel)(id, project, identity),
      refresh: () => this.refreshHeader(page),
      observe: (id) => void page.orch.observeModel?.(id).then(ack => this.note(`orchestrator: ${ack}`, page), error => this.note(dim(`orchestrator did not acknowledge the model: ${error instanceof Error ? error.message : String(error)}`), page)),
    });
  }

  private modelPageCurrent(page: Page, operation: number): boolean {
    return operation === this.modelGeneration && this.page === page && this.pages.includes(page) && !page.deleting;
  }

  /** A change agents read before their next request (/model, /effort, /fast): saved at once unless workers or reviewers of `scope` run, else after "switch …". */
  private async confirmAll(page: Page, operation: number, question: string, save: () => Promise<void>, scope: Scope = "all"): Promise<void> {
    if (!this.modelPageCurrent(page, operation)) return;
    const agents = await Promise.try(this.deps.modelAgents ?? liveAgentsOrNull, page.project).catch(() => null);
    if (!this.modelPageCurrent(page, operation)) return;
    if (agents === null) return this.note(dim("could not determine running agents; try again"), page);
    const confirm = switchAllMenu(question, agents, scope);
    return confirm ? this.openMenu(confirm.title, confirm.choices, async (confirmed) => { if (confirmed) await save(); }, operation) : save();
  }

  /**
   * A sent line, guarded in this order:
   * 1. a known command that needs no page runs at once (agent view, sign-in, no page: all fine);
   * 2. with no page open, anything else (/compact, an unknown command, plain text) opens a fresh orch-xxxx and is dropped;
   * 3. a known command runs on the page;
   * 4. an unknown one (or arguments to a command that takes none) notes "unknown command /x" above the composer;
   * 5. plain text goes to the selected agent or orchestrator; orchestrator input queues while signing in.
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
    if (call) return this.note(`unknown command ${call.name}`);
    return this.talk(page, text, attachments);
  }

  /** Plain text follows the visible recipient; feedback can resume an idle worker. */
  private async talk(page: Page, text: string, attachments: ImageRef[] = []): Promise<void> {
    if (page.view) { try { this.note(await (this.deps.feedback ?? sendAgentFeedback)(page.project, page.view.name, text, attachments)); } catch (e) { this.note(`feedback: ${e instanceof Error ? e.message : String(e)}`); } return; }
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
      return this.note(dim("queued; runs after sign-in"), page);
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
    page?.orch.cancel?.();
    // Persistent-stop feedback replaces this hint in the same temporary row.
    this.note("stopping conversation + agents; send to resume. ctrl+c within 2s exits.", page);
    this.draw();
  }

  private vimMode: "normal" | "insert" | undefined;
  private vimPrefix?: { key: "g"; at: number };
  private vimCommand?: string;
  /** Normal-mode Shift letters, each the action of a key or command that exists without Vim. */
  private readonly vimActions = new Map<string, () => Promise<void> | void>([
    ["A", () => this.work.show("agents")], ["T", () => this.work.show("tasks")], ["Q", () => this.work.show("questions")], ["P", () => this.work.show("images")],
    ["B", () => this.work.show("projects")], ["U", () => this.accountsMenu(this.page)], ["E", () => this.effortMenu(this.page)], ["?", () => this.toggleHelp()],
    ["V", () => this.pasteImage()], ["X", () => this.removeImage()], ["S", () => this.stopMenu()],
    ["H", () => this.switchTab(-1)], ["L", () => this.switchTab(1)], ["M", () => this.vimModelMenu()], ["F", () => this.vimFastMenu()], [":", () => { this.vimCommand = ""; }],
  ]);

  /** A project tab switch from anywhere: it closes whatever is open over the conversation. */
  private switchTab(delta: number): void { this.menu = null; this.work.close(); this.switchPage(delta); }

  /** Shift+S: stop the conversation and its agents after a Cancel-default confirmation (Ctrl+C stops at once). */
  private stopMenu(): void {
    const page = this.page;
    if (!page) return;
    this.openMenu("Stop this conversation and its agents?", [{ label: "Cancel", value: false }, { label: "Stop", value: true }], confirmed => {
      if (confirmed && this.page === page && this.validPage(page)) { page.orch.cancel?.(); this.note("Stopping conversation and agents.", page); }
    });
  }

  private vimNavigation(k: Key): Key {
    if (this.vimMode !== "normal" || k.ctrl || k.alt || k.name !== "char") return k;
    const motion: Record<string, string> = { h: "left", j: "down", k: "up", l: "right", G: "end" };
    if (k.text === "g") {
      if (this.vimPrefix?.key === "g" && this.clock.now() - this.vimPrefix.at < 1500) {
        this.vimPrefix = undefined;
        return { name: "home" };
      }
      this.vimPrefix = { key: "g", at: this.clock.now() };
      return k;
    }
    this.vimPrefix = undefined;
    const name = motion[k.text ?? ""];
    return name ? { name } : k;
  }

  private async vimKey(k: Key): Promise<boolean> {
    if (!this.vimMode || k.ctrl || k.alt || this.clearing || this.keyEcho) return false;
    if (this.vimCommand !== undefined) {
      if (k.name === "escape") this.vimCommand = undefined;
      else if (k.name === "enter") {
        const command = this.vimCommand.trim().replace(/^\//, "");
        this.vimCommand = undefined;
        if (command) await this.submit("/" + command);
      } else if (k.name === "backspace") this.vimCommand = [...this.vimCommand].slice(0, -1).join("");
      else if (k.name === "tab") {
        const prefix = "/" + this.vimCommand.replace(/^\//, "");
        const matches = [...this.commands.keys()].filter(name => name.startsWith(prefix));
        if (matches.length === 1) this.vimCommand = matches[0]!.slice(1) + " ";
      } else if (typedText(k)) this.vimCommand += typedText(k);
      this.draw(); return true;
    }
    const key = k.name === "char" ? k.text : undefined;
    const prefix = this.vimPrefix;
    this.vimPrefix = undefined;
    if (prefix && this.clock.now() - prefix.at < 1500) {
      if (prefix.key === "g" && (key === "t" || key === "T")) { this.switchTab(key === "t" ? 1 : -1); return true; }
      if (prefix.key === "g" && key === "g") { this.jumpChat(false); return true; }
    }
    const action = this.vimMode === "normal" && key ? this.vimActions.get(key) : undefined;
    if (action) { await action(); this.draw(); return true; }
    if (this.vimMode === "insert") {
      if (k.name !== "escape") return false;
      this.vimMode = "normal";
      this.vimPrefix = undefined;
      this.draw(); return true;
    }
    if (key === "g") this.vimPrefix = { key, at: this.clock.now() };
    else if (key === "i") this.vimMode = "insert";
    else if (key === "j" || key === "k") this.scroll({ name: key === "j" ? "down" : "up" });
    else if (key === "G") this.jumpChat(true);
    else if (key === "h" || key === "l") this.edit({ name: key === "h" ? "left" : "right" });
    else if (k.name === "escape" && this.page?.view) this.page.view.leave();
    else if (this.canScroll(k)) return false;
    this.draw(); return true;
  }

  private jumpChat(end: boolean): void {
    this.selectionPausedFollow = false;
    this.scrollTop = end ? null : 0;
    this.scrollAnchor = undefined;
    this.draw();
  }

  private vimModelMenu(): void {
    this.openMenu("model role", [
      { label: "All agents", value: "" }, { label: "Orchestrator", value: "orch" },
      { label: "Worker", value: "worker" }, { label: "Reviewer", value: "reviewer" },
    ], role => this.modelCommand(role, this.page));
  }

  private vimFastMenu(): void {
    this.openMenu("Fast mode", [{ label: "On", value: "on" }, { label: "Off", value: "off" }],
      value => this.requestSetting(this.page, value, "fast"));
  }

  /** Ctrl chords that work everywhere (plain control bytes, so they arrive in every terminal; raw mode, so ^Z does not suspend). */
  private readonly chords = new Map<string, () => Promise<void> | void>([
    ["t", () => this.work.toggle("tasks")],
    ["c", () => this.interrupt()],
    ["g", () => { this.keyEcho = true; this.note(dim("press keys; esc ends")); }],
    ["q", () => this.work.show("questions")],
    ["a", () => this.work.show("agents")],
    ["b", () => this.work.toggle("projects")],
    ["n", () => this.newPage()],
    ["z", () => this.switchPage(-1)],
    ["x", () => this.switchPage(1)],
  ]);

  /**
   * Who gets a key the work page did not take: the first layer whose (pure) `takes` says yes. In order:
   * 0. clear: local Cancel-default confirmation owns all keys; navigation cancels it first;
   * 1. keyEcho: Ctrl+G echoes every key except Ctrl+C until Esc;
   * 2. chords: Ctrl+C cancels (twice exits), Ctrl+N opens a page, Ctrl+Z / Ctrl+X switch pages, Ctrl+A/T/Q/B open the work page on their tab (T and B close it when it already shows), Ctrl+G starts the key echo;
   * 3. menu: every key while a settings menu is open;
   * 4. help: scroll or dismiss the explicit help panel, preserving the composer;
   * 5. images: Ctrl+V attaches the clipboard image, Ctrl+Y removes the last one;
   * 6. escape: leaves the agent view, else clears the input;
   * 7. enter: Enter without Shift or Alt submits;
   * 8. editor: the rest edits the input (EDITS, ↑↓ history).
   */
  readonly keyLayers: readonly KeyLayer[] = [
    { name: "clear", takes: () => !!this.clearing, handle: k => this.clearKey(this.vimNavigation(k)) },
    { name: "keyEcho", takes: (k) => this.keyEcho && !(k.ctrl && k.name === "c"), handle: (k) => this.echoKey(k) },
    { name: "chords", takes: (k) => !!k.ctrl && this.chords.has(k.name), handle: (k) => this.chords.get(k.name)!() },
    { name: "menu", takes: () => !!this.menu, handle: (k) => this.menuKey(k) },
    { name: "help", takes: () => this.helpTop !== null, handle: (k) => this.helpKey(k) },
    { name: "images", takes: k => !!k.ctrl && !k.alt && ["v", "y"].includes(k.name), handle: k => k.name === "v" ? this.pasteImage() : this.removeImage() },
    { name: "escape", takes: (k) => k.name === "escape", handle: () => this.escapeKey() },
    { name: "enter", takes: (k) => k.name === "enter" && !k.shift && !k.alt, handle: () => this.enterKey() },
    { name: "editor", takes: () => true, handle: (k) => { this.edit(k); this.draw(); } },
  ];

  private readonly pointer = new Pointer();
  /** Every mouse report. A click on a link opens it (mouse reporting keeps the click from the terminal, and no report says Cmd is held).
   * A drag selects: history rows when it began on one (they scroll with their text), the painted frame anywhere else. */
  private async mouse(k: Key): Promise<void> {
    const frame = this.resizeTimer ? undefined : this.screen;
    const { click, url } = this.pointer.track(k, frame?.rows);
    if (url) { this.clearSelection(); this.pointer.frame.clear(); return this.note(dim(await openLink(url, this.deps.openUrl))); }
    if (k.name === "mousedown") this.pointer.inBody = !!frame && this.selectionAllowed() && !this.needReprint && !!hitRow(k, frame, this.screenHistory.length);
    if (this.pointer.inBody) { this.pointer.frame.clear(); if (click) this.toolClick(k); return this.selectionMouse(k); }
    this.clearSelection();
    const done = !!frame && this.pointer.frame.mouse(k); // Before any await: the reports of one drag arrive in one burst.
    if (this.work.open && !this.clearing && k.name === "mousedown") await this.work.key(k);
    this.draw();
    if (done) await this.copySelection();
  }

  /** The painted frame is what a click hit: not while a reprint is due, nor when the frame shows another page or view than the current one. */
  private clickable(): StickyScreen | undefined {
    if (!this.selectionAllowed() || this.resizeTimer || this.needReprint || (this.page?.view ?? this.page) !== this.screenOwner) return;
    return this.screen;
  }

  /** The folded group whose summary row is painted history row `index`: where its run starts in the page's (or view's) lines. */
  private groupAt(page: Page, index: number, cols: number): number | undefined {
    const lines = page.view?.lines ?? page.lines, shown = this.shown(page);
    const at = captureAnchor(shown, cols, index);
    return at.part === 0 ? groupStart(lines, shown, at.line) : undefined;
  }

  /** A click on a folded group's summary line opens it (its calls under the summary), or closes it again: the only way to see a run's calls. */
  private toolClick(k: Key): void {
    const screen = this.clickable(), page = this.page;
    const hit = screen && page && hitRow(k, screen, this.screenHistory.length);
    const start = hit ? this.groupAt(page, hit.row, screen.cols) : undefined;
    if (start === undefined || !page) return;
    const lines = page.view?.lines ?? page.lines;
    const open = this.openGroups.get(lines) ?? new Set<number>();
    if (!open.delete(start)) open.add(start);
    this.openGroups.set(lines, open);
    this.clearSelection(); // the rows under it moved
    this.reprint();
  }

  private async selectionMouse(k: Key): Promise<void> {
    const screen = this.screen;
    if (!this.selectionAllowed() || !screen || this.resizeTimer || this.needReprint) return this.clearSelection();
    // Hit-test the painted frame, not the pending scroll destination. Only a
    // new selection pins follow mode; motion/release must not undo queued scroll.
    const completed = this.selection.mouse(k, screen, this.screenHistory);
    if (k.name === "mousedown" && this.selection.active && this.scrollTop === null) {
      this.selectionPausedFollow = true;
      this.scrollTop = screen.start;
    }
    if (!this.selection.active) this.clearSelection();
    this.draw();
    if (completed) await this.copySelection();
  }

  private async copySelection(): Promise<void> {
    if (this.resizeTimer) return;
    this.flush(); // Validate against the latest layout before copying, even between frames.
    const text = (this.selectionAllowed() ? this.selection.text() : "") || this.pointer.frame.text();
    if (!text) return;
    try { await (this.deps.clipboardText ?? writeClipboardText)(text); }
    catch (error) { this.note(dim(`copy failed: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  async onKey(k: Key): Promise<void> {
    // Kitty/modifyOtherKeys may report Shift+letter separately; legacy terminals
    // send the uppercase character. Normalize both without changing Ctrl/Alt.
    if (k.shift && !k.ctrl && !k.alt && /^[a-z?/]$/.test(k.name)) k = { name: "char", text: k.name === "/" ? "?" : k.name.toUpperCase() };
    this.clearNote(k);
    if (!this.keyEcho && !this.clearing && !this.work.confirming) {
      if (k.ctrl && !k.alt && this.chords.has(k.name)) return this.chords.get(k.name)!();
      const text = !k.ctrl && !k.alt && k.name === "char" ? k.text : undefined;
      // A find or a typed answer on the work page takes letters as text: no Vim letter, no q.
      if (!this.work.typing) {
        if (this.vimMode === "normal" && (this.vimCommand !== undefined || text && this.vimActions.has(text) || this.vimPrefix?.key === "g" && (text === "t" || text === "T"))) {
          await this.vimKey(k);
          return;
        }
        if (text === "q" && (this.vimMode === "normal" || !this.vimMode) && (this.work.open || this.menu || this.helpTop !== null || this.page?.view)) k = { name: "escape" };
        // The page moves with its own g/gg; a g there still starts gt/gT.
        if (this.vimMode === "normal" && this.work.open) this.vimPrefix = text === "g" && !this.vimPrefix ? { key: "g", at: this.clock.now() } : undefined;
      }
    }
    // Ctrl+C retains the global cancellation/double-press exit path even when
    // the page is loading, failed, or waiting on an unresponsive registry.
    if (!this.keyEcho && ["mousedown", "mousemove", "mouseup"].includes(k.name)) return this.mouse(k);
    if (!this.keyEcho && k.ctrl && k.name === "o") return this.copySelection();
    if (this.pointer.frame.active && !k.name.startsWith("wheel")) { this.pointer.frame.clear(); this.draw(); }
    if (this.work.open && !this.keyEcho && !this.clearing && !(k.ctrl && k.name === "c")) return this.work.key(k);
    if (!this.selectionAllowed()) this.clearSelection();
    this.clearNote(k);
    if (k.name === "escape" && this.selection.active) { this.clearSelection(); this.draw(); return; }
    // Editing within this draft is fine. Navigation/modal/send/clear/history keys
    // invalidate asynchronous reads, even if the user returns before completion.
    if (!(k.ctrl && k.name === "v") && !typedText(k) && !["left", "right", "backspace", "delete"].includes(k.name)) this.clipboardGeneration++;
    if (this.vimMode && !this.menu && !this.clearing && !this.keyEcho && this.helpTop === null && await this.vimKey(k)) return;
    if (this.canScroll(k)) return this.scroll(k);
    if (k.name === "escape") this.modelGeneration++;
    for (const layer of this.keyLayers) if (layer.takes(k)) return layer.handle(k);
  }

  private canScroll(k: Key): boolean {
    return ["pageup", "pagedown", "wheelup", "wheeldown"].includes(k.name) && !this.clearing && !this.keyEcho && !this.menu && this.helpTop === null;
  }

  private scroll(k: Key): void {
    const screen = this.screen;
    if (!screen) return;
    this.selectionPausedFollow = false; // Explicit scrolling owns the viewport, even during a drag.
    const delta = k.name === "up" || k.name === "down" ? 1 : k.name.startsWith("wheel") ? 3 : Math.max(1, screen.bodyHeight - 1);
    const start = this.scrollTop ?? screen.maxStart;
    const top = Math.max(0, Math.min(screen.maxStart, start + (k.name.endsWith("up") ? -delta : delta)));
    this.scrollTop = top === screen.maxStart ? null : top;
    this.scrollAnchor = undefined;
    this.draw();
  }

  /** Only rewrap on width/context changes, not on every live-activity tick. */
  private helpView(): Help | null {
    if (this.helpTop === null) return null;
    const cols = this.deps.term.cols, inView = !!this.page?.view, vim = !!this.vimMode;
    if (this.helpContent?.cols !== cols || this.helpContent.inView !== inView || this.helpContent.vim !== vim) {
      this.helpContent = { cols, inView, vim, lines: helpLines(this.commands, inView, cols, vim) };
    }
    return { lines: this.helpContent.lines, top: this.helpTop };
  }

  /** Explicit modal, independent of chat/answer buffers and conversation scroll. */
  private toggleHelp(): void {
    if (this.vimMode) this.vimMode = "normal";
    this.work.close();
    this.cancelClear();
    this.helpTop = this.helpTop === null ? 0 : null;
    if (this.helpTop !== null) this.menu = null;
    this.draw();
  }

  private helpKey(k: Key): void {
    k = this.vimNavigation(k);
    if (k.name === "escape") { this.helpTop = null; this.draw(); return; }
    if (k.ctrl || k.alt) return;
    const panel = helpPanel({ ...this.frame(), rows: this.composerRows() });
    const step = Math.max(1, panel.bodyHeight - 1);
    const delta: Record<string, number> = { up: -1, down: 1, pageup: -step, pagedown: step, wheelup: -3, wheeldown: 3 };
    const top = k.name === "home" ? 0 : k.name === "end" ? panel.maxTop : panel.top + (delta[k.name] ?? 0);
    this.helpTop = Math.max(0, Math.min(panel.maxTop, top));
    this.draw();
  }

  private readonly taskSnapshot = new WeakMap<Page, { stamp: string; at: number }>();

  private async refreshTaskViews(page = this.page, force = true): Promise<void> {
    if (!page || !this.validPage(page)) return;
    const now = this.clock.now();
    if (!force && !this.deps.tasks && !this.deps.taskCount && !this.deps.treeTasks) {
      const info = await stat(`${paths.project(page.project)}/tasks.json`, { bigint: true }).catch(() => undefined);
      const stamp = info ? `${info.ino}:${info.mtimeNs}:${info.size}` : "missing";
      const previous = this.taskSnapshot.get(page);
      // SQL is authoritative if a projection write was interrupted.
      if (previous?.stamp === stamp && now - previous.at < 30_000) return;
      this.taskSnapshot.set(page, { stamp, at: now });
    }
    await this.work.refresh("tasks", page);
    await this.taskCounts.refresh(page);
  }

  /** Ctrl+G: show each key as parsed; Esc ends. */
  private echoKey(k: Key): void {
    if (k.name !== "escape") return this.note(dim(JSON.stringify(k)));
    this.keyEcho = false;
    this.note(dim("done"));
  }

  /** Navigate the settings menu, confirm a selection or dismiss it. */
  private async menuKey(k: Key): Promise<void> {
    const m = this.menu!;
    const navigation = this.vimNavigation(k);
    const id = menuKeyId(navigation);
    const n = Math.max(1, m.items.length);
    if (navigation.name === "home") m.index = 0;
    else if (navigation.name === "end") m.index = n - 1;
    else if (id === "up") m.index = (m.index + n - 1) % n;
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
      this.note(dim("draft images are not sent with slash commands. ctrl+y removes the last image; esc clears this draft."));
      return this.draw();
    }
    if (attachments.length && Buffer.byteLength(text) > 60000) return this.note(dim("image prompt text exceeds 60,000 bytes; shorten it before sending. draft retained."));
    if (attachments.length && this.page?.view) return this.note(dim("return to project chat before sending images."));
    if (this.page) this.draftImages.delete(this.page);
    if (text !== "/help") this.scrollTop = null;
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
      this.authorizedPages.add(page);
      await this.keepDaemon(page.project, page);
    }
    catch (err) {
      const at = page.sent.indexOf(sent);
      if (attachments.length) sent.retry = true;
      else if (at !== -1) page.sent.splice(at, 1);
      this.note(dim(`not sent: ${text}${imageLabels(attachments)}${attachments.length ? "; retained in this window (t on the Images page retries)" : ""}`), page);
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
      .catch((err) => this.note(dim(`could not save input history: ${err instanceof Error ? err.message : String(err)}`), page));
  }

  private recall(dir: -1 | 1): void {
    if (this.images().length) return this.note(dim("remove draft images (ctrl+y) before recalling a different prompt from history."));
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
