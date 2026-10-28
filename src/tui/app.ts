import { navigateOutline, renderTaskTree, type TaskTreeRender } from "./components";
import { ConversationSelection, hitRow } from "./screen";
import { writeClipboardText, readClipboardImage, type ClipboardImage } from "./components";
import { imageLabels, MAX_IMAGES, pendingImageInputs, saveImage, saveImageInput } from "../core/data/images";
import type { ImageRef } from "../protocol";
import { contextStatus, dispatchStatus, reviewStatus } from "./header";
import { allTasks, listTasks, removeTask } from "../core/data/tasks";
import { refreshTaskInboxData, TaskCounts, taskInboxLines, type TaskInboxData } from "./footer";
import { cancelSession } from "../core/tmux";
import { settingChange, effectiveSettings, setEffort } from "../core/data/projects";
import type { RequestSettings } from "../providers/catalog";
// Sticky top and bottom bars around a scrollable conversation. Only changed
// screen rows are redrawn; on exit the active transcript is printed back to
// the terminal's normal scrollback. One page per orchestrator: Ctrl+N starts one named
// orch-xxxx (/rename gives it a display name), Ctrl+Z and Ctrl+X move between
// them, Ctrl+B or /projects lists every project (open, pin, delete) like a
// menu. Type to talk to the page's orchestrator; worker and reviewer reports
// arrive through its inbox and show up while you wait. /help lists the commands.

import { accountChoices, login, useAccount, sendAgentFeedback, runtimeText, usageText } from "./commands";
import { deleteProject, type DeleteOptions } from "./commands";
import { listAgents, liveAgents, liveAgentsOrNull } from "../core/tmux";
import type { AgentInfo } from "../protocol";
import { displayName, listProjects, newProjectName, orderedProjects, projectFor, remoteOf, setDisplayName, shortRemote, togglePin, validProjectName } from "../core/data/projects";
import type { ProjectEntry } from "../protocol";
import { effortChoices, modelChoices, setModel, switchAllMenu, type Choice } from "./commands";
import { reviewRounds, dynamicDispatch } from "./commands";
import { paths, validRounds } from "../config";
import { projectIdentity } from "../core/data/projects";
import { validateModel, effectiveModel } from "../core/data/projects";
import { effectiveFlow, type FlowSettings } from "../core/data/projects";
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
import { pageQuestions, Questions, QUESTION_DELAY_MS, QUESTION_PROGRESS, type PageQuestions, type QuestionStore } from "./footer";
import { fromUserLines, replyLine, reportLine, restore, plainToolLine, unresolvedCalls, userLines } from "./conversation";
import { bold, dim, fit, sanitize } from "./components";
import { commit, helpPanel, taskInboxPanel, inputArea, inputGeometry, statusRows, type Frame, type Help, type TaskInboxView, type Input, type InputArea, type Menu } from "./footer";
import type { Terminal } from "./components";
import { shimmer } from "./components";
import { chapterRows, headerHeight } from "./header";
import { captureAnchor, resolveAnchor, type HistoryAnchor } from "./conversation";
import { Calls, collapseCalls, groupStart, groupStarts } from "./conversation";
import { agentRow, reselect } from "./header";
import type { ToolCall, ToolOutcome } from "../protocol";
import { stickyRows, stickyUpdate, type StickyScreen } from "./screen";

export { helpLines } from "./footer";
export { lineRows, type Line } from "./conversation";

import { type Page, type AppDeps, type ToolEvents, type Clock, type Note, realClock, SPINNER, NO_PAGE_FOR_SETTINGS, FRAME_MS, RESIZE_MS, SPIN_MS, TICK_MS, LIVE_CHECK_MS, AGENTS_TICK_MS, AGENTS_REFRESH_MS, type ProjectListState, type ActiveMenu, type AgentsTimer, type TaskTreeState, type TaskInboxState, type ClearConfirmation, type Command, parseCommand, listKeyId, type KeyLayer, MENU_CHARS, menuKeyId, active, EDITS, typedText } from './app-state';
export { type Page, type AppDeps, type ToolEvents, type Clock, AGENTS_TICK_MS, type Command, parseCommand, type KeyLayer } from './app-state';

export class App {
  pages: Page[] = [];
  private modelGeneration = 0;
  private clearing?: ClearConfirmation;
  private _active = 0;
  get active(): number { return this._active; }
  set active(index: number) {
    if (index !== this._active) { this.taskTree = null; this.clipboardGeneration++; if (this.page) this.questions.hide(this.page); this.cancelClear(); this.modelGeneration++; this.helpTop = null; this.taskInbox = null; }
    this._active = index; if (this.page) void this.taskCounts.refresh(this.page); // opening or switching to a page reads its task count
  }
  private looseLines: string[] = [];
  input = { text: "", cursor: 0 };
  /** First input row on screen, kept between frames so the input area scrolls only when the cursor leaves it. */
  private inputTop: number | undefined;
  /** Null until explicitly opened; only a footer scroll position, never a history line. */
  private helpTop: number | null = null;
  /** One explicit panel, owned by the captured page object; never reused across projects. */
  private taskInbox: TaskInboxState | null = null;
  private taskTree: TaskTreeState | null = null;
  private readonly taskCounts = new TaskCounts<Page>(page => (this.deps.taskCount ?? this.deps.tasks ?? listTasks)(page.project), page => this.validPage(page), () => this.draw());

  private toggleTaskTree(): void {
    if (this.taskTree) { this.taskTree = null; this.draw(); return; }
    if (!this.page || this.clearing || this.keyEcho) return;
    this.taskTree = { page: this.page, tasks: [], collapsed: new Set(), frame: 0, graphX: 0, graphY: 0, detailY: 0, loading: true };
    void this.refreshTaskTree();
    this.draw();
  }

  private refreshTaskTree(): Promise<void> {
    const view = this.taskTree;
    if (!view) return Promise.resolve();
    if (view.reading) { view.again = true; return view.reading; }
    view.reading = (async () => {
      do {
        view.again = false;
        await this.readTaskTree(view);
      } while (view.again && this.taskTree === view && !this.closed);
    })().finally(() => { view.reading = undefined; });
    return view.reading;
  }

  /** Apply one snapshot only while its overlay still owns the result. */
  private async readTaskTree(view: TaskTreeState): Promise<void> {
    try {
      const tasks = await (this.deps.treeTasks ?? allTasks)(view.page.project);
      if (this.taskTree !== view || this.closed) return;
      view.tasks = tasks; view.error = undefined;
    } catch (error) {
      if (this.taskTree !== view || this.closed) return;
      view.error = `Tasks unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    view.loading = false;
    this.draw();
  }

  private treeScreen(): StickyScreen {
    const view = this.taskTree!, { cols, rows } = this.deps.term;
    const rendered = renderTaskTree(view.error ? [] : view.tasks, { ...view, cols, rows: Math.max(1, rows - 2) });
    view.rendered = rendered;
    view.revealSelected = false;
    if (!view.error && !view.loading) view.selectedId = rendered.selectedId;
    view.graphX = rendered.graph.x; view.graphY = rendered.graph.y; view.detailY = rendered.details.y;
    const lines = view.error || view.loading
      ? [fit(sanitize(view.error ?? "Loading tasks…"), cols)] : rendered.lines;
    const controls = [view.confirmRemoval ? "Remove merged task from list? y confirm / n cancel (SQL retained)" : view.notice ?? "Ctrl+T/Esc chat · r refresh · d remove merged · terminal gesture opens PR links",
      view.detailsFocused ? "Details: ↑↓ scroll · ← list" : "↑↓ select · ← fold/parent · → expand/details"].map(line => fit(line, cols));
    const content = Array.from({ length: Math.max(0, rows - 2) }, (_, i) => lines[i] ?? "");
    return { rows: [...content, ...controls].slice(0, rows), cols, cursor: Math.max(0, rows - 1), col: 0,
      bodyTop: 0, bodyHeight: rows, start: 0, maxStart: 0 };
  }

  private taskTreeKey(k: Key): void {
    const view = this.taskTree!;
    if (view.removing) return;
    if (view.confirmRemoval) {
      if (k.name === "char" && k.text === "y") void this.confirmTaskRemoval(view);
      else if (k.name === "escape" || k.name === "char" && k.text === "n") { view.confirmRemoval = undefined; this.draw(); }
      return;
    }
    if (k.name === "escape" || k.ctrl && k.name === "t") return this.toggleTaskTree();
    if (k.name === "char" && k.text === "r") { void this.manualTreeRefresh(view); return; }
    if (k.name === "char" && k.text === "d") {
      const selected = view.tasks.find(t => t.id === view.selectedId);
      if (!view.error && !view.loading && selected?.archive) { view.confirmRemoval = selected.id; view.notice = undefined; }
      else view.notice = "Only verified merged tasks can be removed.";
      this.draw(); return;
    }
    const rendered = view.rendered;
    if (!rendered || view.error || view.loading) return;
    if (k.name === "mousedown") this.selectTreeHit(view, rendered, k);
    else if (!k.ctrl && !k.alt) {
      if (k.name === "tab" && k.shift) this.cycleTreeSelection(view, rendered);
      else this.scrollTaskTree(view, rendered, k);
    }
    this.draw();
  }

  /** `r`: say a re-read started and when it landed; an unchanged registry otherwise changes nothing visible. */
  private async manualTreeRefresh(view: TaskTreeState): Promise<void> {
    view.notice = "Refreshing…"; this.draw(); await this.refreshTaskTree();
    if (this.taskTree === view && view.notice === "Refreshing…") { view.notice = view.error ? undefined : `Refreshed ${new Date(this.clock.now()).toTimeString().slice(0, 8)} · Esc chat`; this.draw(); }
  }

  private async confirmTaskRemoval(view: TaskTreeState): Promise<void> {
    const id = view.confirmRemoval;
    if (!id || this.taskTree !== view) return;
    view.removing = true;
    try {
      await (this.deps.removeTask ?? removeTask)(view.page.project, id, true);
      if (this.taskTree !== view) return;
      view.notice = "Removed from list; task memory and dependencies retained.";
      await this.refreshTaskTree();
    } catch (error) { view.notice = `Removal refused: ${error instanceof Error ? error.message : String(error)}`; }
    finally { view.removing = false; view.confirmRemoval = undefined; if (this.taskTree === view) this.draw(); }
  }

  private selectTreeHit(view: TaskTreeState, rendered: TaskTreeRender, k: Key): void {
    // Renderer hits already include viewport clipping/offsets. Only convert
    // terminal 1-based coordinates; subtracting graph offsets again is wrong.
    const row = (k.y ?? 0) - 1, col = (k.x ?? 0) - 1;
    const hit = rendered.hits.find(h => h.row === row && col >= h.col && col < h.col + h.width);
    if (hit) { view.selectedId = hit.id; view.detailY = 0; view.detailsFocused = false; }
  }

  private cycleTreeSelection(view: TaskTreeState, rendered: TaskTreeRender): void {
    if (!rendered.order.length) return;
    const next = (rendered.order.indexOf(view.selectedId ?? "") + 1) % rendered.order.length;
    view.selectedId = rendered.order[next];
    view.revealSelected = true;
    view.detailY = 0;
  }

  private focusTaskDetails(view: TaskTreeState, key: string): boolean {
    if (view.detailsFocused) {
      if (key === "left") view.detailsFocused = false;
      if (key === "up") view.detailY--;
      if (key === "down") view.detailY++;
      return true;
    }
    if (key !== "right" || view.collapsed.has(view.selectedId ?? "")) return false;
    view.detailsFocused = true;
    return true;
  }

  private scrollTaskTree(view: TaskTreeState, rendered: TaskTreeRender, k: Key): void {
    if (this.focusTaskDetails(view, k.name)) return;
    if (["up", "down", "left", "right"].includes(k.name)) {
      view.selectedId = navigateOutline(rendered.nodes, view.selectedId, view.collapsed, k.name);
      view.revealSelected = true;
      view.detailY = 0;
    } else if (k.name === "pageup" || k.name === "pagedown") {
      view.detailY += (k.name === "pageup" ? -1 : 1) * Math.max(1, rendered.details.rows - 1);
    } else if (k.name === "wheelup" || k.name === "wheeldown") {
      view.graphY += k.name === "wheelup" ? -1 : 1;
    }
  }

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
    if (!page || page.view || page.questions.expanded) return this.note(dim("open a project chat before attaching an image (not a question answer)."));
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
    if (!page || page.view || this.loggingIn) return this.note(dim("open project chat and finish sign-in before retrying images."));
    await this.recoverImages(page);
    for (const item of [...page.sent]) if (item.attachments?.length && item.retry) {
      await this.send(page, item.text, item.submission, item.inputId, item.attachments).catch(error => this.note(dim(String(error)), page));
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
  /** Per-page read generations for the project's review limit and dispatch switch; a slow read never replaces a newer one. */
  private readonly flowVersions = new WeakMap<Page, number>();
  /** The last flow read failure said per page, so a poll repeats a persisting error once, not every 2 s. */
  private readonly flowErrors = new WeakMap<Page, string>();
  private readonly deferredRefresh = new Set<Page>();
  private readonly renderedHeads = new WeakMap<Page, string | undefined>();
  private readonly refreshedTurns = new WeakSet<Page>();
  /** Pages whose last rendering left out calls the running turn has not finished (they show as running rows instead); re-rendered once the turn ends. */
  private readonly hidRunning = new WeakSet<Page>();
  private readonly notices = new WeakMap<Page, Line[]>();
  /** Each page's transient status note (one row above the composer; the next keypress on that page after it was drawn clears it), and the one shown while no page is open. */
  private readonly notes = new WeakMap<Page, Note>();
  private looseNote: Note | undefined;

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
      say: (line, page) => app.note(line, page as Page),
      note: (text, page) => app.note(text, page as Page),
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
    term.onKey((k) => { this.onKey(k).catch((err) => this.note(`error: ${err instanceof Error ? err.message : String(err)}`)); });
    term.onResize(() => this.resized());
    const poll = setInterval(() => {
      if (this.page) this.checkLive(this.page.project);
      this.watchPages();
      this.questions.poll(this.pages);
      if (this.taskTree && !this.taskTree.removing) void this.refreshTaskTree();
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
      catch (error) { this.note(`could not open ${name}: ${error instanceof Error ? error.message : String(error)}`); }
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

  quit(): void { this.taskInbox = null; this.cancelClear(); this.modelGeneration++; this.done(); }

  // --- output -----------------------------------------------------------------

  /** Append a finished line to the page's agent view if one is up, else to the page (or the screen when there is none). */
  say(line: string, page = this.page): void {
    if (!page) { this.looseLines.push(line); this.pending.push(line); return this.draw(); }
    if (page.view) this.toView(page, page.view, [line]);
    else { this.keepNotice(page, line); this.toPage(page, [line]); }
  }

  /**
   * Runtime feedback ("model set to …", a rename, what the daemon
   * keeper did): one dim row directly above the composer, replacing the page's
   * previous note, never in the conversation or its restored history. Like the
   * project list's status, the next keypress clears it; a mouse event does not.
   */
  note(text: string, page = this.page): void {
    const note: Note = { text };
    if (page) this.notes.set(page, note); else this.looseNote = note;
    this.draw();
  }

  /** The next input key clears the note, even before its queued frame paints; scrolling and mouse selection leave it. */
  private clearNote(k: Key): void {
    if (/^(?:wheel|mouse|page)/.test(k.name)) return;
    const page = this.page;
    const note = page ? this.notes.get(page) : this.looseNote;
    if (!note) return;
    if (page) this.notes.delete(page); else this.looseNote = undefined;
    this.draw();
  }

  /** The shown page's note, cut to one row. Rendering never changes its lifetime. */
  private noteRow(page: Page | undefined): string | undefined {
    const note = page ? this.notes.get(page) : this.looseNote;
    if (!note) return undefined;
    return dim(fit(sanitize(note.text.replace(/\s*\n\s*/g, " ")), this.deps.term.cols));
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
    const showImages = refs.length > 0 && !page?.questions.expanded;
    const note = this.noteRow(page); // Errors must remain visible while answering questions too.
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
    return chapterRows({ tabs: this.pages, active: this.pages.indexOf(page), model, context: this.contextLabel(page), review: reviewStatus(page.review), dispatch: dispatchStatus(page.dispatch), directory: paths.repo(page.project), remote: page.remote ? shortRemote(page.remote) : "no remote", agent: page.view?.name, fin: decorate && !this.newChat(page) ? { time: this.clock.now(), active: page.view ? page.view.live : page.busy } : undefined }, this.deps.term.cols, headerHeight(this.deps.term.rows));
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

  private bumpFlow(page: Page): number {
    const version = (this.flowVersions.get(page) ?? 0) + 1;
    this.flowVersions.set(page, version);
    return version;
  }

  /** The page's project's review limit and dispatch switch in one read per page per refresh, never during paint.
   * A slow pre-save/pre-refresh read must never replace a newer observation; a failed or invalid read shows both as unknown. */
  private async refreshFlow(page: Page): Promise<void> {
    const version = this.bumpFlow(page);
    let review: number | undefined, dispatch: boolean | undefined;
    try {
      const saved = await (this.deps.flowSettings ?? effectiveFlow)(page.project);
      if (validRounds(saved?.maxReviewRounds)) review = saved.maxReviewRounds;
      if (typeof saved?.dynamicDispatch === "boolean") dispatch = saved.dynamicDispatch;
    } finally {
      if (version === this.flowVersions.get(page) && !this.closed && (page.review !== review || page.dispatch !== dispatch)) {
        page.review = review;
        page.dispatch = dispatch;
        if (page === this.page) this.draw();
      }
    }
  }

  /** A poll's flow read failure is said once per distinct error per page; success clears it so a recurrence is reported again. */
  private async pollFlow(page: Page): Promise<void> {
    try { await this.refreshFlow(page); this.flowErrors.delete(page); }
    catch (err) {
      const line = `project settings refresh failed: ${err}`;
      if (this.flowErrors.get(page) === line) return;
      this.flowErrors.set(page, line);
      this.note(dim(line), page);
    }
  }

  /** Settings feedback, including refusals, uses the temporary status row. */
  private flowCommand(page: Page | undefined, args: string, command: typeof reviewRounds): Promise<void> | void {
    if (!page) return this.note(dim(NO_PAGE_FOR_SETTINGS));
    this.bumpFlow(page); // invalidate observations started before this save
    return command(page.project, args).then(async result => {
      this.note(result, page);
      await this.refreshFlow(page); // read the saved value, never infer success from input
    });
  }

  private spinner(): string { return SPINNER[Math.floor(this.clock.now() / SPIN_MS) % SPINNER.length]!; }

  /** Counts only: no shortcuts, repeated identities or transient animation in the footer. */
  status(page: Page): string {
    const agents = page.agentCount ?? 0;
    const known = (p: Page) => p.questions.loaded && !p.questions.error, questions = known(page) ? page.questions.open.length : "?";
    const background = this.pages.filter(p => p !== page), elsewhere = background.reduce((n, p) => n + (known(p) ? p.questions.open.length : 0), 0);
    const unknown = background.some(p => !known(p));
    return [`${agents} ${agents === 1 ? "agent" : "agents"} running`, this.taskCounts.label(page), `inbox ${questions}${elsewhere || unknown ? ` (+${elsewhere || ""}${unknown ? (elsewhere ? "+?" : "?") : ""} elsewhere)` : ""}`].join(" │ ");
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
    const want = !this.closed && (fast || this.pages.some(active) || !!this.taskTree?.rendered?.animated);
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
    if (this.taskTree?.rendered?.animated) this.taskTree.frame = (this.taskTree.frame + 1) % 4;
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
    if (!this.taskTree) this.questions.sync(); // the input holds the chat draft or the shown question's answer, as the state now wants
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
      if (!this.taskTree) this.questions.sync(); // the input holds the chat draft or the shown question's answer
      const next = this.taskTree ? this.treeScreen() : this.viewport(this.frame());
      const output = stickyUpdate(next, this.screen);
      if (!this.taskTree) this.needReprint = false;
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
          ...this.pages.map(page => this.pollFlow(page)),
        ]);
        await this.refreshProjects().catch(err => this.note(dim(`refresh projects failed: ${err}`)));
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
    if (consumed) page.sent = page.sent.filter(m => !consumed.has(m.inputId));
    const entries = page.orch.entries?.();
    if (!entries) return;
    const head = entries.at(-1)?.uuid;
    if (this.renderedHeads.get(page) === head) return;
    const boundary = entries.findLast(entry => entry.type === "context-boundary")?.uuid, cleared = boundary !== page.contextBoundary;
    page.contextBoundary = boundary;
    if (cleared) {
      this.notices.delete(page); this.notes.delete(page); this.openGroups.delete(page.lines);
      if (page === this.page && !page.view) {
        this.pending = []; this.screenHistory = []; this.scrollTop = null; this.scrollAnchor = undefined; this.selection.clear();
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
    const tools: ToolEvents = { onRefresh: () => { this.syncTranscript(page); this.refreshedTurns.add(page); }, onTool: (call) => this.toolStarted(page, call), onToolResult: (outcome) => this.toPage(page, [page.calls.finish(outcome)]), notice: text => this.note(text, page) };
    page.orch = await this.deps.openOrchestrator(project, url, (text, plain) => this.stream(page, text, plain), (msgs) => this.inbox(page, msgs), tools);
    // Like `claude --continue`: the page starts with what its transcript showed live (from the transcript the orchestrator loaded), and ↑ recalls what was typed.
    // A turn already running elsewhere (the daemon's) shows its unfinished calls live, not as interrupted.
    this.syncTranscript(page, await page.orch.pending().catch(() => false));
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
    catch (error) { this.note(dim(`image recovery failed: ${error}`), page); }
    await this.pollFlow(page);
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
    if (name && [...shown].some(([id, n]) => id !== name && n === name)) return this.note(dim(`another project is already called ${name}`));
    const project = name ?? newProjectName([...shown.keys(), ...shown.values()]);
    try {
      const page = await this.openPage(project, url ?? this.deps.source ?? undefined);
      if (!name) this.note("/rename <name> to rename", page);
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
      if (this.projectList) await this.refreshProjects();
    } catch (err) { this.note(`error: ${err instanceof Error ? err.message : String(err)}`, page); }
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
    try { await this.openPage(name); } catch (err) { this.note(`error: ${err instanceof Error ? err.message : String(err)}`); }
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
    if (!agents.length) return this.note(dim("no agents yet"));
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

  private async accountsMenu(page?: Page): Promise<void> {
    this.modelGeneration++;
    if (!page) return this.note(dim("open a project before choosing its account"));
    const identity = projectIdentity(page.project);
    this.openMenu("accounts: enter uses one for this project or signs it in", await accountChoices(dim, page.project), async (account) => {
      if (!account.ok) return this.login(`${account.provider} ${account.profile}`, page, true);
      this.note(await useAccount(account, page.project, identity).catch((err: unknown) => dim(err instanceof Error ? err.message : String(err))), page); await this.refreshHeader(page);
    });
  }

  private async modelMenu(page: Page, operation: number, identity: string): Promise<void> {
    this.note("fetching models…", page);
    const { choices, errors } = await (this.deps.modelChoices ?? modelChoices)(dim, page.project);
    if (this.notes.delete(page)) this.draw();
    if (!this.modelPageCurrent(page, operation)) return;
    for (const e of errors) this.note(dim(e));
    if (!choices.length) return this.note(dim("no models available; sign in with /login first"));
    this.openMenu("switch model   (/accounts for another provider)", choices, async (id) => this.switchModel(page, id, operation, identity), operation);
  }

  private async attach(page: Page, name: string, live: boolean): Promise<void> {
    this.cancelClear();
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r, live, calls: new Calls() }));
    const view = page.view!;
    if (page === this.page) this.reprint();
    this.note(dim("esc or /back returns"), page);
    await follow(paths.transcript(page.project, name), (_s, entry) => this.toView(page, view, view.calls.absorb(parts(entry) ?? [])), stopped, 300, () => { if (!view.live) this.toView(page, view, view.calls.interrupt()); }, text => this.note(text, page));
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
      if (watchers.length) void Promise.all(watchers.map(w => w(p.project).catch(() => {}))).then(() => this.refreshTaskInbox(p));
    }
  }

  /** Start the project's orchestrator daemon when none is alive: what it did or why it could not, as temporary feedback. */
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
    const failure = texts.some(m => m.attachments?.length) ? "sign-in failed; image prompts retained for /retry-images" : `sign-in failed; dropped ${texts.length} queued message(s)`;
    while (texts.length) {
      const { text, submission, inputId, attachments } = texts.shift()!; // ownership transfers to send (Page.sent), or an explicit drop report
      if (ok && this.pages.includes(page)) await this.send(page, text, submission, inputId, attachments).catch(() => {});
      else {
        if (attachments?.length) page.sent.push({ text, submission, inputId, attachments, retry: true });
        this.note(dim(`not sent after sign-in (${page.name}): ${text}${imageLabels(attachments)}${attachments?.length ? "; /retry-images" : ""}`), this.pages.includes(page) ? page : this.page);
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
    ["/runtime", { needsPage: true, run: async (_, page) => this.note(await runtimeText(page!.project)), help: { group: "advanced", label: "/runtime", description: "loaded builds, context observations and background commands" } }],
    ["/usage", { needsPage: true, run: async (_, page) => this.note(await usageText(page!.project)), help: { group: "advanced", label: "/usage", description: "measured project tokens, cached input and request time" } }],
    ["/refresh", { run: () => this.refreshSessions(), help: { group: "conversation", label: "/refresh", description: "reload shared local state; active context waits until idle; never runs work" } }],
    ["/projects", { run: () => this.openProjects(), help: { group: "projects", label: "/projects", description: "browse projects: enter opens, p pins, d deletes" } }],
    ["/retry-images", { run: (_, page) => this.retryImages(page), help: { group: "conversation", label: "/retry-images", description: "retry unconfirmed image prompts by original id; never replay consumed input" } }],
    ["/keys", { run: () => { this.keyEcho = true; this.note(dim("press keys; esc ends")); }, help: { group: "advanced", label: "/keys", description: "diagnose keys/wheel; ctrl+g keeps draft; esc ends" } }],
    ["/rename", { args: true, run: (args) => this.renamePage(args), help: { group: "projects", label: "/rename <name>", description: "change display name only; project id stays fixed" } }],
    ["/new", { args: true, run: (args) => this.newCommand(args), help: { group: "projects", label: "/new [name] [directory]", description: "create a project page" } }],
    ["/close", { run: () => this.closePage(), help: { group: "projects", label: "/close", description: "close this page; keep its project and history" } }],
    ["/quit", { run: () => this.quit(), help: { group: "projects", label: "/quit", description: "exit; keep conversation history" } }],
    ["/inbox", { run: (_, page) => this.toggleTaskInbox(page), help: { group: "conversation", label: "/inbox", description: "user inbox: tasks / questions; shift+tab switches sections, esc/tab closes" } }],
    ["/agents", { needsPage: true, run: (_, page) => this.agentsMenu(page!), help: { group: "conversation", label: "/agents", description: "browse and follow agent conversations" } }],
    ["/effort", { args: true, run: (args, page) => args ? this.requestSetting(page, args, "effort") : this.effortMenu(page), help: { group: "settings", label: "/effort [level|default]", description: "choose or set project/model reasoning effort" } }],
    ["/fast", { args: true, run: (args, page) => this.requestSetting(page, args, "fast"), help: { group: "settings", label: "/fast [on|off]", description: "show or set project/model fast mode" } }],
    ["/clear", { run: (_, page) => this.clearCommand(page), help: { group: "conversation", label: "/clear", description: "clear conversation, context and cache after confirmation" } }],
    ["/compact", { needsPage: true, run: async (_, page) => { await page!.orch.compact?.(); }, help: { group: "advanced", label: "/compact", description: "summarize model context; keep full history" } }],
    ["/model", { run: (_, page) => this.modelCommand(page), help: { group: "settings", label: "/model", description: "choose the project model from its account" } }],
    ["/accounts", { run: (_, page) => this.accountsMenu(page), help: { group: "settings", label: "/accounts", description: "choose a subscription account" } }],
    ["/login", { args: true, run: (args, page) => this.login(args, page), help: { group: "settings", label: "/login claude|codex [profile]", description: "sign in to a subscription account" } }],
    ["/review-rounds", { args: true, run: (args, page) => this.flowCommand(page, args, reviewRounds), help: { group: "advanced", label: "/review-rounds [n]", description: "project review rounds before ci; 0 goes straight to ci" } }],
    ["/dynamic-dispatch", { args: true, run: (args, page) => this.flowCommand(page, args, dynamicDispatch), help: { group: "settings", label: "/dynamic-dispatch [on|off]", description: "show or set the project's dynamic dispatch" } }],
    ["/questions", { run: (_, page) => this.questions.command(page), help: { group: "conversation", label: "/questions", description: "inbox questions (ctrl+q); enter answers or picks skip; shift+tab tasks" } }],
    ["/back", { run: (_, page) => (page?.view ? page.view.leave() : this.note(dim("not viewing an agent"))), help: { group: "conversation", label: "/back", description: "return from agent view (also esc)", viewOnly: true } }],
    ["/help", { run: () => this.toggleHelp(), help: { group: "conversation", label: "/help", description: "commands and keyboard shortcuts; esc closes" } }],
  ]);

  /** Clear is a local modal, never a prompt or a scheduled model turn. */
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
      this.helpTop = null;
      this.taskInbox = null;
      this.projectList = null;
      this.menu = operation.menu = {
        title: dim(`clear conversation, context and cache for ${page.name}? saved transcript stays. ↑↓ enter · esc`),
        items: ["cancel", "clear conversation"], index: 0,
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
      this.syncTranscript(page);
      this.note("conversation, model context and cache cleared.", page);
    } catch (error) {
      if (this.clearCurrent(operation)) this.note(dim(`cannot clear: ${error instanceof Error ? error.message : error}`), page);
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
    if (name && !validProjectName(name)) return this.note(dim("project ids are letters, digits, . _ or -; /rename sets a free-form name"));
    return this.newPage(name, directory);
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
    catch (err) { this.notes.delete(page); return this.note(dim(err instanceof Error ? err.message : String(err)), page); }
    if (this.notes.delete(page)) this.draw();
    if (!this.modelPageCurrent(page, operation)) return;
    if (picker.note) this.note(picker.note, page);
    this.openMenu(`effort for ${picker.model}   (/effort <level|default> sets directly)`, picker.choices, (level) => this.saveSetting(page, operation, `set effort for ${picker.model} to ${level}?`, () => setEffort(page.project, picker.model, level, identity)), operation);
  }

  /** /model opens the picker of the project's account's models; there is no id argument. */
  private async modelCommand(page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.note(dim("open a project before changing its model"));
    await this.modelMenu(page, operation, projectIdentity(page.project));
  }

  private modelPageCurrent(page: Page, operation: number): boolean {
    return operation === this.modelGeneration && this.page === page && this.pages.includes(page) && !page.deleting;
  }

  private async switchModel(page: Page, id: string, operation: number, identity: string): Promise<void> {
    validateModel(id);
    await this.confirmAll(page, operation, `switch this project to ${id}?`, () => this.commitModel(page, id, operation, identity));
  }

  /** A change every agent reads before its next request (/model, /effort, /fast): saved at once unless workers or reviewers run, else after "switch all". */
  private async confirmAll(page: Page, operation: number, question: string, save: () => Promise<void>): Promise<void> {
    if (!this.modelPageCurrent(page, operation)) return;
    const agents = await Promise.try(this.deps.modelAgents ?? liveAgentsOrNull, page.project).catch(() => null);
    if (!this.modelPageCurrent(page, operation)) return;
    if (agents === null) return this.note(dim("could not determine running agents; try again"), page);
    const confirm = switchAllMenu(question, agents);
    return confirm ? this.openMenu(confirm.title, confirm.choices, async (confirmed) => { if (confirmed) await save(); }, operation) : save();
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
    void page.orch.observeModel?.(id).then(ack => this.note(`orchestrator: ${ack}`, page), error => this.note(dim(`orchestrator did not acknowledge the model: ${error instanceof Error ? error.message : String(error)}`), page));
  }

  /**
   * A sent line, guarded in this order:
   * 1. a known command that needs no page runs at once (agent view, sign-in, no page: all fine);
   * 2. with no page open, anything else (/agents, an unknown command, plain text) opens a fresh orch-xxxx and is dropped;
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
    if (page?.view) {
      const view = page.view;
      await (this.deps.cancelAgent ?? cancelSession)(page.project, view.name);
      this.note("stopping selected agent. press ctrl+c again within 2 seconds to exit.", page);
    } else {
      page?.orch.cancel?.();
      // A transient note; the daemon's acknowledgement replaces it (same row) and the header's fin stops once the turn ends.
      this.note("turn cancelled. send a message to resume; press ctrl+c again within 2 seconds to exit.", page);
    }
    this.draw();
  }

  /** Ctrl chords that work everywhere (plain control bytes, so they arrive in every terminal; raw mode, so ^Z does not suspend). */
  private readonly chords = new Map<string, () => Promise<void> | void>([
    ["t", () => this.toggleTaskTree()],
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
  ]);

  /**
   * Who gets a key: the first layer whose (pure) `takes` says yes. In order:
   * 0. clear: local Cancel-default confirmation owns all keys; navigation cancels it first;
   * 1. keyEcho: /keys echoes every key except Ctrl+C until Esc;
   * 2. chords: Ctrl+C cancels (twice exits), Ctrl+N opens a page, Ctrl+Z / Ctrl+X switch pages, Ctrl+G opens draft-safe /keys;
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

  /** Where the mouse last went down: a release on the same cell is a click. */
  private pressed?: { x?: number; y?: number };

  /** A press and a release on the same cell: the released report, else nothing. */
  private click(k: Key): Key | undefined {
    if (k.name === "mousedown") { this.pressed = { x: k.x, y: k.y }; return; }
    if (k.name !== "mouseup") return;
    const down = this.pressed;
    this.pressed = undefined;
    return down && down.x === k.x && down.y === k.y ? k : undefined;
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
    const screen = this.click(k) && this.clickable(), page = this.page;
    const hit = screen && page && hitRow(k, screen, this.screenHistory.length);
    const start = hit ? this.groupAt(page, hit.row, screen.cols) : undefined;
    if (start === undefined || !page) return;
    const lines = page.view?.lines ?? page.lines;
    const open = this.openGroups.get(lines) ?? new Set<number>();
    if (!open.delete(start)) open.add(start);
    this.openGroups.set(lines, open);
    this.selection.clear(); // the rows under it moved
    this.reprint();
  }

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
    catch (error) { this.note(dim(`copy failed: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  async onKey(k: Key): Promise<void> {
    // Ctrl+C retains the global cancellation/double-press exit path even when
    // the overlay is loading, failed, or waiting on an unresponsive registry.
    if (this.taskTree && !(k.ctrl && k.name === "c")) return this.taskTreeKey(k);
    if (!this.selectionAllowed()) this.selection.clear();
    if (!this.keyEcho && ["mousedown", "mousemove", "mouseup"].includes(k.name)) { this.toolClick(k); return this.selectionMouse(k); }
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

  private async refreshTaskInbox(page = this.page): Promise<void> {
    if (this.taskTree?.page === page) await this.refreshTaskTree();
    const view = this.taskInbox; // the status bar's count follows every poll/session refresh, from the open panel's read when there is one
    if (!view || view.page !== page || !this.taskInboxCurrent(view)) return page && this.taskCounts.refresh(page);
    return refreshTaskInboxData(view, () => this.taskCounts.observe(page, (this.deps.tasks ?? listTasks)(page.project)),
      () => this.taskInboxCurrent(view), () => { view.content = undefined; this.draw(); });
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
    if (k.name !== "escape") return this.note(dim(JSON.stringify(k)));
    this.keyEcho = false;
    this.note(dim("done"));
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
      this.note(dim("draft images are not sent with slash commands. ctrl+y removes the last image; esc clears this draft."));
      return this.draw();
    }
    if (attachments.length && Buffer.byteLength(text) > 60000) return this.note(dim("image prompt text exceeds 60,000 bytes; shorten it before sending. draft retained."));
    if (attachments.length && this.page?.view) return this.note(dim("return to project chat before sending images."));
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
      this.note(dim(`not sent: ${text}${imageLabels(attachments)}${attachments.length ? "; retained in this window for /retry-images" : ""}`), page);
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
