import { formatDateTime } from "../protocol";
import { stat } from "node:fs/promises";
import { abandonTask } from "../core/data/tasks/tasks";
import { ARCHIVED_SECTION, withArchiveSection, workColumns, workDetails, workRows } from "./components/work-view";
import { canArchiveTask } from "../protocol/task";
import { workViews } from "../core/data/projects";
import type { Question } from "../protocol";
import { recentAgent } from "./commands/agents";
import { controlProcess, processOwner, listProcesses, unresolvedProcess, liveProcess } from "../core/data/processes";
import { launchIdentity } from "../core/tmux";
import { navigateOutline, renderTaskTree, type TaskTreeRender } from "./components";
import { ConversationSelection, hitRow } from "./screen";
import { writeClipboardText, readClipboardImage, type ClipboardImage } from "./components";
import { imageLabels, MAX_IMAGES, pendingImageInputs, saveImage, saveImageInput } from "../core/data/images";
import type { ImageRef } from "../protocol";
import { contextStatus } from "./header";
import { allTasks, listTasks, removeTask, restoreTask } from "../core/data/tasks";
import { runningAgentCount, TaskCounts } from "./footer";
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

import { accountChoices, login, useAccount, sendAgentFeedback, runtimeText, usageText, restoreConversations, directoryProjectCommand, directoryDefaultsCommand, projectMenu } from "./commands";
import { checkContextClear, deleteProject, type DeleteOptions } from "./commands";
import { archiveAgents, restoreAgents, listAgents, activeAgentRows, liveAgentsOrNull } from "../core/tmux";
import type { AgentInfo } from "../protocol";
import { directories, displayName, listProjects, newProjectName, orderedProjects, projectFor, remoteOf, setDisplayName, shortRemote, togglePin, validProjectName } from "../core/data/projects";
import type { ProjectEntry } from "../protocol";
import { activeRoles, chooseModel, effortChoices, modelChoices, pageAccount, roleModelsLabel, setModel, switchAllMenu, type Choice, type Scope } from "./commands";
import { paths } from "../config";
import { projectIdentity } from "../core/data/projects";
import { effectiveModel } from "../core/data/projects";
import type { Message } from "../protocol";
import type { Orchestrator } from "../core/agent-loop/orc";
import type { Entry } from "../protocol";
import { format } from "node:util";
import { taskNumberKey, follow, parts } from "./conversation";
import { editor as ed } from "./footer";
import type { Key } from "./components";
import { historyRows, type Line, type Shown } from "./conversation";
import { appendHistory, keepable, loadHistory, remember, MAX_INPUT_HISTORY } from "./history";
import { MarkdownStream } from "./conversation";
import { helpLines, type CommandHelp } from "./footer";
import { fileStore, pageQuestions, questionPageRows, Questions, QUESTION_DELAY_MS, QUESTION_PROGRESS, type PageQuestions, type QuestionStore } from "./footer";
import { clearChatView, visibleChatEntries, fromUserLines, replyLines, reportLine, restore, plainToolLine, unresolvedCalls, userLines } from "./conversation";
import { deliveredImages, deliveredImageData, type DeliveredImage } from "./commands";
import { open } from "../core/data/transcripts";
import { bold, dim, fit, sanitize, repositoryTitle } from "./components";
import { commit, helpPanel, inputArea, inputGeometry, statusRows, type Frame, type Help, type TaskInboxView, type Input, type InputArea, type Menu } from "./footer";
import type { Terminal } from "./components";
import { shimmer } from "./components";
import { chapterRows, headerHeight } from "./header";
import { captureAnchor, resolveAnchor, type HistoryAnchor } from "./conversation";
import { Calls, collapseCalls, groupStart, groupStarts } from "./conversation";
import type { ToolCall, ToolOutcome } from "../protocol";
import { stickyRows, imagePreviewUpdate, type ImagePlacement, type StickyScreen } from "./screen";

export { helpLines } from "./footer";
export { lineRows, type Line } from "./conversation";

import { type Page, type AppDeps, type ToolEvents, type Clock, type Note, realClock, SPINNER, FRAME_MS, RESIZE_MS, SPIN_MS, TICK_MS, LIVE_CHECK_MS, AGENTS_TICK_MS, type ProjectListState, type ActiveMenu, type TaskTreeState, type ClearConfirmation, type Command, parseCommand, listKeyId, type KeyLayer, MENU_CHARS, menuKeyId, active, EDITS, typedText } from './app-state';
export { type Page, type AppDeps, type ToolEvents, type Clock, AGENTS_TICK_MS, type Command, parseCommand, type KeyLayer } from './app-state';

interface WorkItem { id: string; title: string; detail: string; archived?: boolean; section?: boolean; agent?: AgentInfo; image?: DeliveredImage; question?: Question }

export class App {
  pages: Page[] = [];
  private modelGeneration = 0;
  private clearing?: ClearConfirmation;
  private _active = 0;
  get active(): number { return this._active; }
  set active(index: number) {
    if (index !== this._active) { this.taskTree = null; this.clipboardGeneration++; if (this.page) this.questions.hide(this.page); this.cancelClear(); this.modelGeneration++; this.helpTop = null; this.workView = null; }
    this._active = index; if (this.page) void this.taskCounts.refresh(this.page); // opening or switching to a page reads its task count
  }
  private looseLines: string[] = [];
  input = { text: "", cursor: 0 };
  /** First input row on screen, kept between frames so the input area scrolls only when the cursor leaves it. */
  private inputTop: number | undefined;
  /** Null until explicitly opened; only a footer scroll position, never a history line. */
  private helpTop: number | null = null;
  /** One explicit panel, owned by the captured page object; never reused across projects. */

  private taskTree: TaskTreeState | null = null;
  private readonly taskCounts = new TaskCounts<Page>(page => (this.deps.taskCount ?? this.deps.tasks ?? listTasks)(page.project), page => this.validPage(page), () => this.draw());

  private toggleTaskTree(): void {
    this.workView = null;
    if (this.taskTree) { this.taskTree = null; this.draw(); return; }
    if (!this.page || this.clearing || this.keyEcho) return;
    if (this.vimMode) this.vimMode = "normal";
    this.questions.hide(this.page);
    this.menu = null; this.projectList = null; this.helpTop = null;
    this.taskTree = { page: this.page, tasks: [], collapsed: new Set(), frame: 0, graphY: 0, detailY: 0, loading: true };
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
    const rendered = renderTaskTree(view.error ? [] : view.tasks, { ...view, workView: true, cols, rows: Math.max(1, rows - 2) });
    view.rendered = rendered;
    view.revealSelected = false;
    if (!view.error && !view.loading) view.selectedId = rendered.selectedId;
    view.graphY = rendered.graph.y; view.detailY = rendered.details.y;
    const lines = view.error || view.loading
      ? [fit(sanitize(view.error ?? "Loading tasks…"), cols)] : rendered.lines;
    const controls = [(this.vimCommand !== undefined ? `:${this.vimCommand}` : view.confirmAbandon?.text) ?? (view.confirmRemoval ? `Archive ${view.confirmRemoval.length} settled task(s)? y confirm / n cancel` : view.notice ?? "q/Esc back · a expand archived · d archive · D bulk · u restore · A abandon · r refresh"),
      view.detailsFocused ? "Details: ↑↓ scroll · ← list · number + Enter jump" : "number + Enter jump · ↑↓ select · ← fold/parent · → unfold/details · Shift+Tab next"].map(line => fit(line, cols));
    if (this.vimMode) controls[0] = fit(`[${this.vimMode.toUpperCase()}] ${controls[0]}`, cols);
    const content = Array.from({ length: Math.max(0, rows - 2) }, (_, i) => lines[i] ?? "");
    return { rows: [...content, ...controls].slice(0, rows), cols, cursor: Math.max(0, rows - 1), col: 0,
      bodyTop: 0, bodyHeight: rows, start: 0, maxStart: 0 };
  }

  private taskTreeKey(k: Key): void {
    const view = this.taskTree!;
    if (view.removing) return;
    if (view.confirmAbandon) {
      const target = view.confirmAbandon;
      if (k.name === "char" && k.text === "y") {
        view.removing = true;
        void abandonTask(view.page.project, target.id, target.revision).then(async () => {
          view.notice = "Task abandoned. Ledger and dependencies retained.";
          await this.refreshTaskTree();
        }).catch(error => { view.notice = error instanceof Error ? error.message : String(error); })
          .finally(() => { view.confirmAbandon = undefined; view.removing = false; this.draw(); });
      } else if (k.name === "escape" || k.name === "char" && k.text === "n") view.confirmAbandon = undefined;
      this.draw(); return;
    }
    if (view.confirmRemoval) {
      if (k.name === "char" && k.text === "y") void this.confirmTaskRemoval(view);
      else if (k.name === "escape" || k.name === "char" && k.text === "n") { view.confirmRemoval = undefined; this.draw(); }
      return;
    }
    if (!view.error && !view.loading && taskNumberKey(view, k)) { this.draw(); return; }
    if (k.name === "escape" || k.ctrl && k.name === "t") return this.toggleTaskTree();
    if (k.name === "char" && k.text === "r") { void this.manualTreeRefresh(view); return; }
    if (k.name === "char" && k.text === "a") {
      view.history = !view.history; view.selectedId = ARCHIVED_SECTION; view.revealSelected = true; view.detailY = 0; this.draw(); return;
    }
    if (view.selectedId === ARCHIVED_SECTION && ["enter", "left", "right"].includes(k.name)) {
      view.history = k.name === "enter" ? !view.history : k.name === "right"; view.detailsFocused = false; this.draw(); return;
    }
    if (k.name === "char" && k.text === "u") {
      const task = view.tasks.find(t => t.id === view.selectedId);
      if (task?.removedAt && !view.loading && !view.error) {
        view.restoring = true; view.confirmRemoval = [task.id]; void this.confirmTaskRemoval(view);
      }
      return;
    }
    if (k.name === "char" && k.text === "A") {
      const task = view.tasks.find(t => t.id === view.selectedId);
      if (!task || task.archive || view.loading || view.error) return;
      const runs = task.runs.filter(run => !run.endedAt && (run.state === "prepared" || run.state === "started"));
      const dependents = view.tasks.filter(t => t.dependsOn?.includes(task.id));
      if (runs.length) view.notice = `Stop ${runs.length} active or queued runs first.`;
      else if (task.pr && task.publication?.state !== "CLOSED") view.notice = `Resolve PR #${task.pr.number} before abandoning.`;
      else view.confirmAbandon = { id: task.id, revision: task.revision,
        text: `Abandon task? ${dependents.length} dependents retained · y confirm / n cancel` };
      this.draw(); return;
    }
    if (k.name === "char" && k.text === "D" && !view.loading && !view.error) {
      const ids = view.tasks.filter(task => canArchiveTask(task) && !task.removedAt).map(task => task.id);
      if (ids.length) view.confirmRemoval = ids;
      else view.notice = "No settled tasks to archive.";
      this.draw(); return;
    }
    if (k.name === "char" && k.text === "d") {
      const selected = view.tasks.find(t => t.id === view.selectedId);
      if (!view.error && !view.loading && selected && canArchiveTask(selected) && !selected.removedAt) { view.confirmRemoval = [selected.id]; view.notice = undefined; }
      else view.notice = "Only merged or abandoned/closed tasks with no active runs or open PR can be archived.";
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
    if (this.taskTree === view && view.notice === "Refreshing…") { view.notice = view.error ? undefined : `Refreshed ${formatDateTime(this.clock.now())} · q/Esc back`; this.draw(); }
  }

  private async confirmTaskRemoval(view: TaskTreeState): Promise<void> {
    const id = view.confirmRemoval;
    if (!id || this.taskTree !== view) return;
    view.removing = true;
    try {
      for (const task of id) {
        if (view.restoring) await restoreTask(view.page.project, task);
        else await (this.deps.removeTask ?? removeTask)(view.page.project, task, true);
      }
      if (this.taskTree !== view) return;
      view.notice = view.restoring ? "Restored to list; work not resumed." : "Archived; task memory and dependencies retained.";
      await this.refreshTaskTree();
      await this.taskCounts.refresh(view.page);
    } catch (error) { view.notice = `Removal refused: ${error instanceof Error ? error.message : String(error)}`; }
    finally { view.removing = false; view.restoring = false; view.confirmRemoval = undefined; if (this.taskTree === view) this.draw(); }
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
    if (k.name === "home" || k.name === "end") {
      if (view.detailsFocused) view.detailY = k.name === "home" ? 0 : rendered.details.height;
      else { view.selectedId = k.name === "home" ? rendered.order[0] : rendered.order.at(-1); view.revealSelected = true; view.detailY = 0; }
      return;
    }
    if (view.detailsFocused && (k.name === "pageup" || k.name === "pagedown")) {
      view.detailY += (k.name === "pageup" ? -1 : 1) * Math.max(1, rendered.details.rows - 1);
      return;
    }
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

  private helpContent?: { cols: number; inView: boolean; vim: boolean; lines: string[] };
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
      && !page.view && !this.menu && !this.projectList && !this.clearing && !this.workView
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
      opening: page => {
        app.cancelClear(); app.modelGeneration++; app.helpTop = null; app.menu = null; app.projectList = null; app.taskTree = null;
        if (app.workView?.kind !== "questions" || app.workView.page !== page)
          app.workView = { page: page as Page, kind: "questions", agents: [], detail: 0, focused: true, history: false };
      },
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
      if (this.workView?.kind === "agents" && !this.workView.busy && !this.workView.confirm && !this.workView.loading) {
        this.workView.loading = true; void this.readWorkView(this.workView);
      }
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

  quit(): void { this.workView = null; this.cancelClear(); this.modelGeneration++; this.done(); }

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
    if (Bun.stripANSI(text).trimStart().startsWith("[model request]")) return; // Older daemons still emit lifecycle diagnostics.
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
    const showImages = refs.length > 0 && !page?.questions.expanded;
    const prefix = "/" + (this.vimCommand ?? "").replace(/^\//, "");
    const matches = this.vimCommand !== undefined && !prefix.includes(" ")
      ? [...this.commands.keys()].filter(name => name.startsWith(prefix)).slice(0, 5) : [];
    const note = this.vimCommand !== undefined
      ? fit(sanitize(`:${this.vimCommand} ▏ ${matches.join("  ")}`), this.deps.term.cols)
      : this.noteRow(page); // Errors must remain visible while answering questions too.
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
      menu: this.menu,
      help: this.helpView(),
      inbox: this.taskInboxView(),
      question: this.questions.view(),
      projects: this.projectList && projectMenu(this.projectList, this.pages, this.page?.project),
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
    return `${page.agentCount ?? "?"} agents | ${this.taskCounts.label(page)} | ${questions} questions | ${images?.count ?? "?"} images`;
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
    const word = shimmer(page.streamed ? "working…" : page.sent.some(item => !item.retry) ? "queued…" : "thinking…", now);
    return `${this.spinner()} ${word}\x1b[2m ${Math.floor((now - page.busySince) / 1000)}s`;
  }

  /** Run the spinner timer only while some page is busy or viewing a live agent. */
  private animate(): void {
    const fast = this.shimmering();
    const ms = fast ? TICK_MS : SPIN_MS;
    const want = !this.closed && (fast || this.pages.some(active) || !!this.taskTree?.rendered?.animated);
    if (this.tickMs !== ms || !want) { this.stopSpinner?.(); this.stopSpinner = null; }
    this.tickMs = ms;
    if (want && !this.stopSpinner) this.stopSpinner = this.clock.every(() => this.tick(), ms);
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
    const cols = this.workView?.kind === "questions" && this.page?.questions.expanded ? workColumns(this.deps.term.cols).right : this.deps.term.cols;
    return inputGeometry(prompt, cols, this.composerRows()).width;
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
    this.clearSelection();
    if (this.closed) return;
    this.cancelClear();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.reprint(); }, RESIZE_MS);
  }

  private flush(): void {
    this.lastFrame = Date.now();
    try {
      if (!this.taskTree) this.questions.sync(); // the input holds the chat draft or the shown question's answer
      this.imagePlacement = undefined;
      const next = this.workView ? this.workScreen() : this.taskTree ? this.treeScreen() : this.viewport(this.frame());
      const output = imagePreviewUpdate(next, this.screen, this.imagePlacement, this.paintedImage);
      if (!this.taskTree && !this.workView) this.needReprint = false;
      // Synchronized output, so the terminal shows the whole update at once.
      if (output) this.deps.term.write(`\x1b[?2026h${output}\x1b[?2026l`);
      this.screen = next;
      this.paintedImage = this.imagePlacement;
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
    return !this.clearing && !this.keyEcho && !this.menu && !this.projectList && this.helpTop === null && !this.workView && !this.page?.questions.expanded;
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
        if (forced || this.projectList) await this.refreshProjects().catch(err => this.note(dim(`refresh projects failed: ${err}`)));
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
      this.notices.delete(page); this.notes.delete(page); this.openGroups.delete(page.lines);
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
    entries = visibleChatEntries(entries, page.chatClearedThrough);
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
    if (this.looseNote !== undefined) { this.notes.set(page, this.looseNote); this.looseNote = undefined; }
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
    if (this.projectList) await this.refreshProjects();
    return page;
  }

  closePage(index = this.active): void {
    this.clipboardGeneration++;
    this.workView = null;
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
      const page = await this.openPage(project, url ?? (this.page ? paths.repo(this.page.project) : this.deps.source) ?? undefined);
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
    if (this.vimMode) this.vimMode = "normal";
    this.workView = null; this.taskTree = null;
    this.cancelClear();
    this.modelGeneration++;
    const items = await directories.projectRows();
    const index = Math.max(0, items.findIndex((it) => it.name === this.page?.project || it.conversations?.includes(this.page?.project ?? "")));
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
    const items = await directories.projectRows(list.parent);
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
    ["n", async () => { const parent = this.projectList?.parent; if (parent) { const p = (await directories.directoryProjects()).find(p => p.id === parent); this.closeProjects(); if (p) await this.newPage(undefined, p.directory); } }],
    ["p", (entry) => this.pinFromProjects(entry)],
    ["d", (entry) => { if (entry.directory) { this.projectList!.status = "open the project to manage its conversations"; return; } this.projectList!.confirm = entry; this.projectList!.status = bold(`delete ${entry.label}? y/n`); }],
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
    const navigation = this.vimNavigation(k);
    if (navigation.name === "home") list.index = 0;
    if (navigation.name === "end") list.index = Math.max(0, list.items.length - 1);
    const id = navigation.name === "left" ? "escape" : navigation.name === "right" ? "enter" : listKeyId(navigation);
    if (id === "escape") { if (list.parent) { this.projectList = null; await this.openProjects(); return; } return this.closeProjects(); }
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
    const parent = (await directories.directoryProjects()).find(p => p.id === name);
    if (parent) {
      this.projectList = { parent: name, items: await directories.projectRows(name), index: 0, status: `${parent.directory} · n new conversation · esc projects`, confirm: null };
      this.draw(); return;
    }
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

  private readonly imageLists = new WeakMap<Page, { head?: string; rows: DeliveredImage[]; archived: Record<string, boolean>; count: number }>();

  private async readImages(page: Page): Promise<void> {
    const path = paths.transcript(page.project, "orchestrator");
    if (!await Bun.file(path).exists()) { this.updateImages(page, []); return; }
    const transcript = open(path);
    this.updateImages(page, transcript.history?.() ?? transcript.branch());
    const list = this.imageLists.get(page)!;
    list.archived = workViews.workArchive(page.project, "images");
    list.count = list.rows.filter(image => !list.archived[image.ref.id]).length;
  }

  private updateImages(page: Page, entries: readonly Entry[]): void {
    const head = entries.at(-1)?.uuid;
    const previous = this.imageLists.get(page);
    if (previous && previous.head === head) return;
    const rows = deliveredImages(entries), archived = workViews.workArchive(page.project, "images");
    this.imageLists.set(page, { head, rows, archived, count: rows.filter(image => !archived[image.ref.id]).length });
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
    if (this.page) this.questions.hide(this.page);
    this.workView = null; this.taskTree = null;
    this.cancelClear();
    if (modelOperation === undefined) this.modelGeneration++;
  }

  private showMenu(menu: ActiveMenu): void {
    if (this.vimMode) this.vimMode = "normal";
    this.helpTop = null;
    this.menu = menu;
    this.draw();
  }

  private workView: {
    page: Page; kind: "agents" | "questions" | "images"; agents: AgentInfo[];
    selected?: string; detail: number; focused: boolean; history: boolean;
    loading?: boolean; notice?: string; confirm?: { text: string; run: () => Promise<void> };
    busy?: boolean;
    archived?: Record<string, boolean>;
    preview?: { id: string; loading: boolean; data?: Awaited<ReturnType<typeof deliveredImageData>>; error?: string };
  } | null = null;
  private imagePlacement?: ImagePlacement;
  private paintedImage?: ImagePlacement;

  /** At most one read per view at a time; rapid navigation skips stale results. */
  private previewImage(view: NonNullable<App["workView"]>, image: DeliveredImage): void {
    if (view.preview?.loading || view.preview?.id === image.ref.id && (view.preview.data || view.preview.error)) return;
    const preview: NonNullable<typeof view.preview> = view.preview = { id: image.ref.id, loading: true };
    void (this.deps.imageData ?? deliveredImageData)(view.page.project, image.ref).then(data => {
      if (this.workView === view && view.selected === image.ref.id) preview.data = data;
    }, error => { preview.error = error instanceof Error ? error.message : String(error); }).finally(() => {
      preview.loading = false;
      if (this.workView === view) this.draw();
    });
  }

  private async openWorkView(kind: "agents" | "questions" | "images", page = this.page): Promise<void> {
    if (!page || !this.validPage(page)) return;
    this.beginMenu();
    if (this.vimMode) this.vimMode = "normal";
    this.menu = null;
    this.projectList = null;
    this.helpTop = null;
    this.taskTree = null;
    this.questions.hide(page);
    const view = this.workView = { page, kind, agents: [], detail: 0, focused: false, history: false, loading: true };
    this.draw();
    await this.readWorkView(view);
  }

  private async readWorkView(view: NonNullable<App["workView"]>): Promise<void> {
    try {
      if (view.kind === "agents") view.agents = await (this.deps.agents ?? listAgents)(view.page.project);
      else if (view.kind === "questions") { await this.questions.refresh(view.page); view.archived = workViews.workArchive(view.page.project, "questions"); }
      else await this.readImages(view.page);
    } catch (error) { view.notice = error instanceof Error ? error.message : String(error); }
    finally { view.loading = false; if (this.workView === view) this.draw(); }
  }

  private workItems(view: NonNullable<App["workView"]>): WorkItem[] {
    if (view.kind === "images") return withArchiveSection((this.imageLists.get(view.page)?.rows ?? []).map(image => ({
      id: image.ref.id, title: image.text.split("\n")[0] || image.ref.id.slice(0, 8),
      detail: [image.text, `From ${image.from}`, formatDateTime(image.at), `Image ${image.ref.id}`].join("\n\n"),
      image, archived: this.imageLists.get(view.page)?.archived[image.ref.id] === true,
    })), view.history);
    if (view.kind === "questions") return withArchiveSection((view.page.questions.all ?? view.page.questions.open).map(question => ({
      id: question.id, title: question.text.replace(/\s+/g, " "),
      detail: [question.text, `Status: ${question.status}`, `Asked ${formatDateTime(question.ts)}`, ...(question.options ?? []).map((option, i) => `${i + 1}. ${option}`),
        ...(question.answer ? [`Answer: ${question.answer}`] : []), ...(question.reason ? [`Reason: ${question.reason}`] : [])].join("\n\n"),
      question, archived: view.archived?.[question.id] ?? question.status !== "open",
    })), view.history);
    return withArchiveSection(view.agents.filter(agent => agent.status !== "unknown").map(agent => ({
      id: agent.name, title: `${agent.name} · ${agent.live ? "running" : agent.archived ? "archived" : "exited"}`,
      detail: [agent.name, agent.activity, agent.startedAt && `Started ${formatDateTime(agent.startedAt)}`,
        agent.endedAt && `Exited ${formatDateTime(agent.endedAt)}`, `${agent.queuedMessages ?? "?"} queued messages`].filter(Boolean).join("\n\n"),
      agent, archived: !agent.live && !agent.queuedMessages && (agent.archived || !recentAgent(agent, this.clock.now())),
    })), view.history);
  }

  private workScreen(): StickyScreen {
    const view = this.workView!, { cols, rows } = this.deps.term;
    const items = this.workItems(view);
    const selected = Math.max(0, items.findIndex(item => item.id === view.selected));
    view.selected = items[selected]?.id;
    const widths = workColumns(cols);
    const room = Math.max(1, rows - 3);
    const listRows = widths.split ? room : Math.max(1, Math.floor(room / 2));
    const detailRows = widths.split ? room : Math.max(0, room - listRows - 1);
    const start = Math.max(0, selected - listRows + 1);
    const left = items.slice(start, start + listRows).map(item =>
      fit((item.id === view.selected ? "› " : "  ") + sanitize(item.title), widths.left));
    if (!left.length) left.push(view.loading ? "Loading…" : `No ${view.kind}`);
    while (left.length < listRows) left.push("");
    const detail = workDetails(items[selected]?.detail ?? "", widths.right);
    view.detail = Math.max(0, Math.min(view.detail, detail.length - detailRows));
    const question = view.kind === "questions" ? this.questions.view() : null;
    const form = question ? questionPageRows(question, { ...this.input, prompt: "answer> ", mode: this.vimMode }, widths.right, detailRows) : undefined;
    let right = form?.rows ?? detail.slice(view.detail, view.detail + detailRows);
    const image = items[selected]?.image;
    if (view.kind === "images" && image) {
      if (!this.deps.term.inlineImages) right = [...right.slice(0, 4), "", ...workDetails("Inline previews need image support in the terminal. Update Hermit to enable them.", widths.right)];
      else {
        this.previewImage(view, image);
        const preview = view.preview, data = preview?.id === image.ref.id ? preview.data : undefined;
        const caption = workDetails(image.text || "Image", widths.right).slice(0, Math.min(3, Math.max(0, detailRows - 2)));
        right = [...caption, "", ...(data ? [] : workDetails(preview?.id === image.ref.id && preview.error ? preview.error : "Loading image…", widths.right))];
        const height = detailRows - caption.length - 1;
        if (data && height > 0) this.imagePlacement = { id: image.ref.id, ...data,
          row: (widths.split ? 1 : listRows + 2) + caption.length + 1, col: widths.split ? widths.left + 3 : 0, width: widths.right, height,
          cellWidth: this.deps.term.imageCell?.width ?? 8, cellHeight: this.deps.term.imageCell?.height ?? 16 };
      }
    }
    const title = view.kind.toUpperCase();
    const lines = workRows(title, cols, left, right).slice(0, Math.max(0, rows - 2));
    while (lines.length < rows - 2) lines.push("");
    const notice = view.page.questions.error && view.kind === "questions" ? `questions unavailable: ${view.page.questions.error}`
      : view.page.questions.closing && view.kind === "questions" ? QUESTION_PROGRESS[view.page.questions.closing] : this.noteRow(view.page) ?? view.notice;
    lines.push(fit(sanitize(view.confirm?.text ?? (this.vimCommand !== undefined ? `:${this.vimCommand}` : notice) ?? (question ? (this.vimMode === "insert" ? "Insert · Esc normal · Enter send" : this.vimMode === "normal" ? "i answer · digits choose · q back" : "Type answer · Enter send · Esc back") : view.kind === "images" ? "↑↓ select · automatic preview · q/Esc back" : "↑↓ select · ←→ focus · Enter open · q/Esc back")), cols));
    if (this.vimMode && !form?.cursor) lines[lines.length - 1] = fit(`[${this.vimMode.toUpperCase()}] ${lines.at(-1)}`, cols);
    lines.push(fit(view.confirm ? "y confirm · n/Esc cancel" : question ? "Tab back to list · Ctrl+D dismiss" : `a expand archived · d archive · D bulk · u restore · r refresh${view.kind === "agents" ? " · s stop" : ""}`, cols));
    return { rows: lines.slice(0, rows), cols, cursor: form?.cursor ? Math.min(rows - 1, (widths.split ? 1 : listRows + 2) + form.cursor.row) : Math.max(0, rows - 1),
      col: form?.cursor ? (widths.split ? widths.left + 3 : 0) + form.cursor.col : 0, bodyTop: 0, bodyHeight: rows, start: 0, maxStart: 0 };
  }

  private async workKey(k: Key): Promise<void> {
    const view = this.workView!;
    const key = k.name === "char" ? k.text : k.name;
    if (view.busy) return;
    if (view.kind === "questions" && view.page.questions.expanded) {
      if (key === "escape" && this.vimMode === "insert") { this.vimMode = "normal"; this.draw(); return; }
      if (key === "escape" || key === "tab") { this.questions.hide(view.page); view.focused = false; this.draw(); return; }
      if (view.page.questions.error || view.page.questions.closing) return;
      if (this.vimMode === "normal" && key === "i") {
        if (this.questions.startAnswer(view.page)) this.vimMode = "insert";
      } else if (!(this.vimMode === "normal" && k.name === "char" && !/^[1-9]$/.test(k.text ?? ""))) {
        const before = view.page.questions.open.map(q => q.id).join();
        if (this.questions.takes(k)) await this.questions.handle(k);
        else if (this.questions.answering()) this.edit(k);
        if (before !== view.page.questions.open.map(q => q.id).join()) {
          this.questions.hide(view.page); if (this.vimMode) this.vimMode = "normal";
          await this.readWorkView(view);
        }
      }
      this.draw(); return;
    }
    if (view.confirm) {
      if (key === "y") {
        view.busy = true;
        try { await view.confirm.run(); await this.readWorkView(view); }
        catch (error) { view.notice = error instanceof Error ? error.message : String(error); }
        finally { view.busy = false; view.confirm = undefined; }
      } else if (key === "n" || key === "escape") view.confirm = undefined;
      this.draw(); return;
    }
    if (key === "escape") { this.workView = null; this.reprint(); return; }
    if (k.ctrl || k.alt) return;
    const items = this.workItems(view);
    const index = Math.max(0, items.findIndex(item => item.id === view.selected));
    const selected = items[index];
    const agent = selected?.agent;
    if (key === "a") {
      view.history = !view.history; view.selected = ARCHIVED_SECTION; view.detail = 0; view.focused = false; this.draw(); return;
    }
    if (selected?.section && ["enter", "left", "right"].includes(key ?? "")) {
      view.history = key === "enter" ? !view.history : key === "right"; view.focused = false; this.draw(); return;
    }
    if (key === "u" && selected?.archived) {
      view.busy = true;
      try {
        if (agent) await (this.deps.restoreAgents ?? restoreAgents)(view.page.project, [agent.name]);
        else if (view.kind !== "agents") workViews.setWorkArchived(view.page.project, view.kind, [selected.id], false);
        await this.readWorkView(view);
        view.notice = "Restored to list. No work resumed or questions reopened.";
      } catch (error) { view.notice = error instanceof Error ? error.message : String(error); }
      finally { view.busy = false; this.draw(); }
      return;
    }
    if ((key === "d" || key === "D") && view.kind !== "agents") {
      const targets = (key === "D" ? items : selected ? [selected] : []).filter(item => !item.section && !item.archived);
      if (targets.length) {
        const kind = view.kind;
        view.confirm = { text: `Archive ${targets.length} ${kind}?${kind === "questions" ? " Open questions will be dismissed without an answer." : " Files retained."}`, run: async () => {
          for (const item of targets) {
            if (item.question?.status === "open") await (this.deps.questions ?? fileStore).skip(view.page.project, item.id);
            workViews.setWorkArchived(view.page.project, kind, [item.id], true);
          }
          view.notice = "Archived. Saved records retained.";
        } };
      } else view.notice = "No items to archive.";
      this.draw(); return;
    }
    if (key === "enter" && selected?.image) return; // selection already previews it in this page
    if (key === "enter" && selected) {
      if (selected.section) return;
      if (selected.question && selected.question.status !== "open") { view.notice = "Closed question; saved answer and reason are shown in details."; this.draw(); return; }
      if (agent) { this.workView = null; view.page.view?.leave(); await this.attach(view.page, agent.name, agent.live); }
      else { view.page.view?.leave(); await this.questions.command(view.page, selected.id); }
      this.reprint(); return;
    }
    if (key === "r") { view.preview = undefined; await this.readWorkView(view); return; }
    if (key === "s" && agent?.live && agent.run && agent.status === "running") {
      const run = agent.run;
      view.confirm = { text: `Stop ${agent.name}?`, run: async () => {
        if (launchIdentity(view.page.project, agent.name) !== run) throw new Error("The selected run changed. Refresh and try again.");
        await cancelSession(view.page.project, agent.name, run);
        const commands = await listProcesses(view.page.project);
        await Promise.all(commands.filter(p => p.owner === agent.name && p.run === run && liveProcess(p)).map(async p => {
          try { await controlProcess(view.page.project, p.id, "stop"); }
          catch (error) {
            if ((await listProcesses(view.page.project)).some(current => current.id === p.id && liveProcess(current))) throw error;
          }
        }));
        view.notice = "Stop requested. Refresh to verify the exit.";
      } };
    }
    if ((key === "d" || key === "D") && view.kind === "agents") {
      const eligible = (row: AgentInfo) => row.status === "exited" && !row.live && !row.archived && row.queuedMessages === 0;
      const candidates = (key === "D" ? view.agents : agent ? [agent] : []).filter(eligible);
      const blocked = new Set((await listProcesses(view.page.project)).filter(p => unresolvedProcess(p)).map(p => processOwner(p)));
      const runs = new Map(candidates.filter(row => !blocked.has(row.name)).map(row => [row.name, row.run]));
      const names = [...runs.keys()];
      if (this.workView !== view) return;
      if (!names.length) view.notice = "No eligible finished agents.";
      else view.confirm = { text: key === "D" ? `Archive ${names.length} finished agents?` : `Archive ${names[0]}?`, run: async () => {
        const current = await (this.deps.agents ?? listAgents)(view.page.project);
        const commands = await listProcesses(view.page.project);
        const safe = current.filter(row => runs.has(row.name) && runs.get(row.name) === row.run && eligible(row) &&
          !commands.some(p => processOwner(p) === row.name && (unresolvedProcess(p)))).map(row => row.name);
        const result = await (this.deps.archiveAgents ?? archiveAgents)(view.page.project, safe);
        view.notice = `Archived ${result.archived.length} of ${names.length} agents. Transcripts retained.`;
      } };
    }
    if (key === "mousedown") {
      const widths = workColumns(this.deps.term.cols);
      const room = Math.max(1, this.deps.term.rows - 3);
      const listRows = widths.split ? room : Math.max(1, Math.floor(room / 2));
      const row = (k.y ?? 0) - 2;
      if (row >= 0 && row < listRows && (k.x ?? 0) <= widths.left) {
        view.selected = items[Math.max(0, index - listRows + 1) + row]?.id ?? view.selected;
        view.focused = false; view.detail = 0;
      } else if (widths.split && (k.x ?? 0) > widths.left + 3) view.focused = true;
    }
    if (key === "left") view.focused = false;
    if (key === "right") view.focused = true;
    const jump = key === "pageup" ? -8 : key === "pagedown" ? 8 : key === "up" || key === "wheelup" ? -1 : key === "down" || key === "wheeldown" ? 1 : 0;
    if (view.focused) {
      if (key === "home") view.detail = 0;
      else if (key === "end") view.detail = Number.MAX_SAFE_INTEGER;
      else view.detail += jump;
    } else if (jump || key === "home" || key === "end") {
      const next = key === "home" ? 0 : key === "end" ? items.length - 1 : index + jump;
      view.selected = items[Math.max(0, Math.min(items.length - 1, next))]?.id;
      view.detail = 0;
    }
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
    this.note(dim("esc or /back returns"), page);
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
    ["/vim", { run: () => {
      this.vimMode = this.vimMode ? undefined : "normal"; this.vimPrefix = undefined; this.draw();
    }, help: { group: "conversation", label: "/vim", description: "toggle Vim navigation and editing modes" } }],
    ["/stop", { run: (_, page) => {
      if (!page) return;
      this.openMenu("Stop this conversation and its agents?", [{ label: "Cancel", value: false }, { label: "Stop", value: true }], confirmed => {
        if (confirmed && this.page === page && this.validPage(page)) {
          page.orch.cancel?.(); this.note("Stopping conversation and agents.", page);
        }
      });
    }, help: { group: "conversation", label: "/stop", description: "confirm a conversation stop" } }],
    ["/paste-image", { run: () => this.pasteImage(), help: { group: "conversation", label: "/paste-image", description: "attach an image from the clipboard" } }],
    ["/remove-image", { run: () => this.removeImage(), help: { group: "conversation", label: "/remove-image", description: "remove the last draft image" } }],
    ["/runtime", { needsPage: true, run: async (_, page) => this.note(await runtimeText(page!.project)), help: { group: "advanced", label: "/runtime", description: "loaded builds, context observations and background commands" } }],
    ["/usage", { needsPage: true, run: async (_, page) => this.note(await usageText(page!.project)), help: { group: "advanced", label: "/usage", description: "measured project tokens, cached input and request time" } }],
    ["/refresh", { run: () => this.refreshSessions(), help: { group: "conversation", label: "/refresh", description: "reload shared local state; active context waits until idle; never runs work" } }],
    ["/projects", { run: () => this.openProjects(), help: { group: "projects", label: "/projects", description: "browse projects: enter opens, p pins, d deletes" } }],
    ["/retry-images", { run: (_, page) => this.retryImages(page), help: { group: "conversation", label: "/retry-images", description: "retry unconfirmed image prompts by original id; never replay consumed input" } }],
    ["/keys", { run: () => { this.keyEcho = true; this.note(dim("press keys; esc ends")); }, help: { group: "advanced", label: "/keys", description: "diagnose keys/wheel; ctrl+g keeps draft; esc ends" } }],
    ["/rename", { args: true, run: (args) => this.renamePage(args), help: { group: "projects", label: "/rename <name>", description: "rename conversation and its folder link; keep its identity" } }],
    ["/new", { args: true, run: (args) => this.newCommand(args), help: { group: "projects", label: "/new [name] [directory]", description: "create a project page" } }],
    ["/close", { run: () => this.closePage(), help: { group: "projects", label: "/close", description: "close this page; keep its project and history" } }],
    ["/quit", { run: () => this.quit(), help: { group: "projects", label: "/quit", description: "exit; keep conversation history" } }],
    ["/tasks", { run: () => this.toggleTaskTree(), help: { group: "conversation", label: "/tasks", description: "open the task list" } }],
    ["/agents", { needsPage: true, run: (_, page) => this.openWorkView("agents", page!), help: { group: "conversation", label: "/agents", description: "open agent runs and history" } }],
    ["/images", { needsPage: true, run: (_, page) => this.openWorkView("images", page), help: { group: "conversation", label: "/images", description: "browse images sent to you; selection previews them here" } }],
    ["/effort", { args: true, run: (args, page) => args ? this.requestSetting(page, args, "effort") : this.effortMenu(page), help: { group: "settings", label: "/effort [level|default]", description: "choose or set project/model reasoning effort" } }],
    ["/fast", { args: true, run: (args, page) => this.requestSetting(page, args, "fast"), help: { group: "settings", label: "/fast [on|off]", description: "show or set project/model fast mode" } }],
    ["/clear", { run: (_, page) => this.clearCommand(page, false), help: { group: "conversation", label: "/clear", description: "clear visible chat only; keep model context, history and cache" } }],
    ["/clear-context", { run: (_, page) => this.clearCommand(page), help: { group: "conversation", label: "/clear-context", description: "clear chat, model context and cache after confirmation" } }],
    ["/compact", { needsPage: true, run: async (_, page) => { await page!.orch.compact?.(); }, help: { group: "advanced", label: "/compact", description: "summarize model context; keep full history" } }],
    ["/project", { args: true, run: (args, page) => page ? directoryProjectCommand(page.project, args).then(text => this.note(text, page)) : this.note("open a conversation first"), help: { group: "settings", label: "/project [rename|relink]", description: "directory project identity, name and location" } }],
    ["/project-defaults", { args: true, run: (args, page) => page ? directoryDefaultsCommand(page.project, args).then(async text => { await this.refreshHeader(page); this.note(text, page); }) : this.note("open a conversation first"), help: { group: "settings", label: "/project-defaults [save|inherit]", description: "save directory defaults or inherit them in this conversation" } }],
    ["/model", { args: true, run: (args, page) => this.modelCommand(args, page), help: { group: "settings", label: "/model [orch|worker|reviewer]", description: "choose the model for all agents or one role" } }],
    ["/accounts", { run: (_, page) => this.accountsMenu(page), help: { group: "settings", label: "/accounts", description: "choose a subscription account" } }],
    ["/login", { args: true, run: (args, page) => this.login(args, page), help: { group: "settings", label: "/login claude|codex [profile]", description: "sign in to a subscription account" } }],
    ["/questions", { run: (_, page) => this.openWorkView("questions", page), help: { group: "conversation", label: "/questions", description: "browse unanswered questions and respond" } }],
    ["/back", { run: (_, page) => (page?.view ? page.view.leave() : this.note(dim("not viewing an agent"))), help: { group: "conversation", label: "/back", description: "return from agent view (also esc)", viewOnly: true } }],
    ["/help", { run: () => this.toggleHelp(), help: { group: "conversation", label: "/help", description: "commands and keyboard shortcuts; esc closes" } }],
  ]);

  /** UI clear is immediate; context reset uses confirmation. Neither submits a prompt. */
  private async clearCommand(page?: Page, context = true): Promise<void> {
    this.cancelClear();
    if (!page) return this.note(dim(context ? "open a project before clearing context" : "open a project before clearing chat"));
    if (!context) {
      this.openGroups.delete(page.view?.lines ?? page.lines); clearChatView(page);
      this.notices.delete(page); this.notes.delete(page); this.pending = []; this.screenHistory = [];
      this.scrollTop = null; this.scrollAnchor = undefined; this.clearSelection(); this.reprint(); return;
    }
    let operation: ClearConfirmation | undefined;
    try {
      this.checkClearPage(page);
      operation = { page, identity: projectIdentity(page.project), controller: new AbortController() };
      this.clearing = operation;
      await page.orch.checkClear!();
      if (!this.clearCurrent(operation)) return;
      this.checkClearPage(page);
      this.helpTop = null;
      this.workView = null;
      this.projectList = null;
      this.menu = operation.menu = {
        title: dim(`clear conversation, context and cache for ${page.name}? saved transcript stays. ↑↓ enter · esc`),
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

  private checkClearPage(page: Page): void {
    checkContextClear(page, this.page, this.pages, this.queued.get(page));
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

  /** /model [orch|worker|reviewer]: the scope step, then the picker of the project's account's models (commands/model-flow.ts); no id argument. */
  private async modelCommand(args: string, page?: Page): Promise<void> {
    const operation = ++this.modelGeneration;
    if (!page) return this.note(dim("open a project before changing its model"));
    const { project } = page, identity = projectIdentity(project);
    await chooseModel(args, {
      project, identity, dim,
      current: () => this.modelPageCurrent(page, operation),
      note: (text) => this.note(text, page),
      unnote: () => { if (this.notes.delete(page)) this.draw(); },
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
    page?.orch.cancel?.();
    // Persistent-stop feedback replaces this hint in the same temporary row.
    this.note("stopping conversation + agents; send to resume. ctrl+c within 2s exits.", page);
    this.draw();
  }

  private vimMode: "normal" | "insert" | undefined;
  private vimPrefix?: { key: " " | "g"; at: number };
  private vimCommand?: string;
  private readonly vimActions = new Map<string, string>([
    ["a", "/agents"], ["t", "/tasks"], ["q", "/questions"], ["p", "/images"],
    ["b", "/projects"], ["u", "/accounts"], ["e", "/effort"], ["?", "/help"],
    ["r", "/refresh"], ["v", "/paste-image"], ["x", "/remove-image"], ["s", "/stop"],
  ]);

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
      if (prefix.key === " " && key) {
        if (key === "h" || key === "l") {
          this.menu = null; this.projectList = null;
          this.switchPage(key === "h" ? -1 : 1);
        } else if (key === "m") this.vimModelMenu();
        else if (key === "f") this.vimFastMenu();
        else {
          const command = this.vimActions.get(key);
          if (command) await this.submit(command);
        }
        this.draw(); return true;
      }
      if (prefix.key === "g" && (key === "t" || key === "T")) {
        this.menu = null; this.projectList = null;
        this.switchPage(key === "t" ? 1 : -1); return true;
      }
      if (prefix.key === "g" && key === "g") { this.jumpChat(false); return true; }
    }
    if (this.vimMode === "normal" && (key === " " || key === ":")) {
      if (key === " ") this.vimPrefix = { key, at: this.clock.now() };
      else this.vimCommand = "";
      this.draw(); return true;
    }
    if (this.page?.questions.expanded && !this.questions.answering()) {
      if (this.vimMode === "normal" && k.name === "char" && k.text === "i") {
        if (this.questions.startAnswer(this.page)) this.vimMode = "insert";
        this.draw(); return true;
      }
      return false;
    }
    if (this.vimMode === "insert") {
      if (k.name !== "escape" || this.page?.questions.expanded) return false;
      this.vimMode = "normal";
      this.vimPrefix = undefined;
      this.draw(); return true;
    }
    if (this.page?.questions.expanded && k.name === "escape") return false;
    if (this.page?.questions.expanded && !typedText(k)) return false;
    if (key === " " || key === "g") this.vimPrefix = { key, at: this.clock.now() };
    else if (key === "i") this.vimMode = "insert";
    else if (key === ":") this.vimCommand = "";
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
    ["t", () => this.toggleTaskTree()],
    ["c", () => this.interrupt()],
    ["g", () => this.commands.get("/keys")!.run("", this.page)],
    ["q", () => this.openWorkView("questions")],
    ["a", () => this.openWorkView("agents")],
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
   * 4. menu: every key while a settings menu is open;
   * 5. help: scroll or dismiss the explicit help panel, preserving the composer;
   * 6. question form: dismissal or guard before input reaches the composer;
   * 7. questions: the keys the shown question takes (questions.ts `takes`), before Esc/Enter;
   * 8. escape: leaves the agent view, else clears the input;
   * 9. enter: Enter without Shift or Alt submits;
   * 10. editor: the rest edits the input (EDITS, ↑↓ history).
   */
  readonly keyLayers: readonly KeyLayer[] = [
    { name: "clear", takes: () => !!this.clearing, handle: k => this.clearKey(this.vimNavigation(k)) },
    { name: "keyEcho", takes: (k) => this.keyEcho && !(k.ctrl && k.name === "c"), handle: (k) => this.echoKey(k) },
    { name: "chords", takes: (k) => !!k.ctrl && this.chords.has(k.name), handle: (k) => this.chords.get(k.name)!() },
    { name: "projects", takes: (k) => this.projectsTake(k), handle: (k) => this.projectsKey(k) },
    { name: "menu", takes: () => !!this.menu, handle: (k) => this.menuKey(k) },
    { name: "help", takes: () => this.helpTop !== null, handle: (k) => this.helpKey(k) },
    { name: "question-dismiss", takes: k => !!this.page?.questions.expanded && !k.ctrl && !k.alt && !k.shift && (k.name === "escape" || k.name === "tab"),
      handle: () => { if (this.page) this.questions.hide(this.page); if (this.vimMode) this.vimMode = "normal"; this.draw(); } },
    { name: "question-guard", takes: () => !!this.page?.questions.expanded && (!!this.page.view || !!this.page.questions.error), handle: () => {} },
    { name: "questions", takes: (k) => this.questions.takes(k), handle: async (k) => {
      await this.questions.handle(k);
      if (this.vimMode && this.questions.answering()) this.vimMode = "insert";
      this.draw();
    } },
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
    this.clearSelection(); // the rows under it moved
    this.reprint();
  }

  private async selectionMouse(k: Key): Promise<void> {
    const screen = this.screen;
    if (!this.selectionAllowed() || !screen || this.resizeTimer || this.needReprint) {
      this.clearSelection();
      return;
    }
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
    if (!this.selectionAllowed() || this.resizeTimer) return;
    // Validate against the latest layout before copying, even between frames.
    this.flush();
    const text = this.selection.text();
    if (!text) return;
    try { await (this.deps.clipboardText ?? writeClipboardText)(text); }
    catch (error) { this.note(dim(`copy failed: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  async onKey(k: Key): Promise<void> {
    this.clearNote(k);
    const confirming = this.clearing || this.workView?.confirm || this.taskTree?.confirmRemoval || this.taskTree?.confirmAbandon || this.projectList?.confirm;
    if (!this.keyEcho && !confirming) {
      if (k.ctrl && !k.alt && this.chords.has(k.name)) return this.chords.get(k.name)!();
      if (k.ctrl && !k.alt && k.name === "b") return this.projectsKey(k);
      const text = !k.ctrl && !k.alt ? (k.name === "char" ? k.text : k.shift && /^[hl]$/.test(k.name) ? k.name.toUpperCase() : undefined) : undefined;
      if (this.vimMode === "normal" && (this.vimCommand !== undefined || text === " " || text === ":" ||
        this.vimPrefix?.key === " " || this.vimPrefix?.key === "g" && (text === "t" || text === "T"))) {
        await this.vimKey(k);
        return;
      }
      if (text === "q" && (this.vimMode === "normal" || !this.vimMode && !this.questions.answering()) &&
        (this.workView || this.taskTree || this.projectList || this.menu || this.helpTop !== null || this.page?.view)) k = { name: "escape" };
    }
    // Ctrl+C retains the global cancellation/double-press exit path even when
    // the overlay is loading, failed, or waiting on an unresponsive registry.
    if (!(k.ctrl && k.name === "c")) {
      if (this.workView && !this.keyEcho) return this.workKey(this.workView.confirm ? k : this.vimNavigation(k));
      if (this.taskTree && !this.taskTree.confirmRemoval && !this.taskTree.confirmAbandon && this.vimMode === "normal"
        && this.taskTree.selectedId !== ARCHIVED_SECTION
        && k.name === "char" && !k.ctrl && !k.alt && (k.text === "h" || k.text === "l")) {
        this.taskTree.detailsFocused = k.text === "l"; this.draw(); return;
      }
      if (this.taskTree) return this.taskTreeKey(this.taskTree.confirmRemoval || this.taskTree.confirmAbandon ? k : this.vimNavigation(k));
    }
    if (!this.selectionAllowed()) this.clearSelection();
    if (!this.keyEcho && ["mousedown", "mousemove", "mouseup"].includes(k.name)) { this.toolClick(k); return this.selectionMouse(k); }
    this.clearNote(k);
    if (!this.keyEcho && k.ctrl && k.name === "o") return this.copySelection();
    if (k.name === "escape" && this.selection.active) { this.clearSelection(); this.draw(); return; }
    // Editing within this draft is fine. Navigation/modal/send/clear/history keys
    // invalidate asynchronous reads, even if the user returns before completion.
    if (!(k.ctrl && k.name === "v") && !typedText(k) && !["left", "right", "backspace", "delete"].includes(k.name)) this.clipboardGeneration++;
    if (this.vimMode === "normal" && this.page?.questions.expanded && !this.questions.answering()) k = this.vimNavigation(k);
    if (this.vimMode && !this.menu && !this.projectList && !this.clearing && !this.keyEcho && this.helpTop === null && await this.vimKey(k)) return;
    if (this.canScroll(k)) return this.scroll(k);
    if (k.name === "escape") this.modelGeneration++;
    for (const layer of this.keyLayers) if (layer.takes(k)) return layer.handle(k);
  }

  private canScroll(k: Key): boolean {
    return ["pageup", "pagedown", "wheelup", "wheeldown"].includes(k.name) && !this.clearing && !this.keyEcho && !this.menu && !this.projectList && this.helpTop === null && !this.workView && !this.page?.questions.expanded;
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
    if (this.page) this.questions.hide(this.page);
    this.workView = null; this.taskTree = null;
    this.cancelClear();
    this.helpTop = this.helpTop === null ? 0 : null;
    if (this.helpTop !== null) { this.menu = null; this.projectList = null; }
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
    if (this.taskTree?.page === page && !this.taskTree.removing) await this.refreshTaskTree();
    await this.taskCounts.refresh(page);
  }

  private taskInboxView(): TaskInboxView | null {
    const page = this.page;
    if (!page?.questions.expanded || page.deleting) return null;
    const q = page.questions;
    return { section: "questions", top: 0, state: q.error ? "error" : !q.loaded ? "loading" : "ready",
      question: this.questions.view(), notice: q.error ? `questions unavailable: ${q.error}` : q.closing ? QUESTION_PROGRESS[q.closing] : undefined,
      lines: page.view ? ["questions belong to the project orchestrator"] : q.error || q.open.length ? [] : [q.loaded ? "no open questions." : "loading questions…"] };
  }

  /** /keys: show each key as parsed; Esc ends. */
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
    if (text !== "/help" && text !== "/questions" && text !== "/refresh") this.scrollTop = null;
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
