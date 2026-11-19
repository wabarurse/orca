// The full-screen page behind Agents, Tasks, Questions, Images and Projects:
// which items each tab lists, what its keys do, and the shared navigation
// (tabs, find, half pages). components/work-view.ts draws it; app.ts routes
// every key here while it is open. Questions are answered through the
// questions controller (footer/questions.ts), so its delivery guarantees hold.
import { homedir } from "node:os";
import { formatDateTime, type AgentInfo, type ProjectEntry, type Question } from "../protocol";
import { canArchiveTask } from "../protocol/task";
import { abandonTask, allTasks, removeTask, restoreTask } from "../core/data/tasks";
import { directories, togglePin, workViews } from "../core/data/projects";
import { bubbleMembers, ensureBubble, peekBubble, readBubble } from "../core/data/bubbles";
import { controlProcess, listProcesses, liveProcess, processOwner, unresolvedProcess } from "../core/data/processes";
import { archiveAgents, cancelSession, launchIdentity, listAgents, ownership, processes, restoreAgents } from "../core/tmux";
const { retire } = ownership;
import { dim, navigateOutline, sanitize, taskRows, taskSections, workView, type Key, type OutlineNode } from "./components";
const { ARCHIVED_SECTION, byDay, findItem, inputLine, renderWorkPage, tableRows, withArchiveSection } = workView;
type WorkPageRender = workView.WorkPageRender;
type WorkRow = workView.WorkRow;
type WorkSection = workView.WorkSection;
import { archiveBubble, archiveFolder, archiveProject, deletionSummary, openDeliveredMedia, recentAgent, type DeliveredMedia } from "./commands";
import { elapsedMs, formatElapsed } from "./header";
import { fileStore, QUESTION_PROGRESS, type Questions } from "./footer";
import type { StickyScreen } from "./screen";
import { typedText, type AppDeps, type Clock, type Page } from "./app-state";

export const WORK_KINDS = ["agents", "tasks", "questions", "images", "processes", "projects"] as const;
export type WorkKind = typeof WORK_KINDS[number];
const TITLES: Record<WorkKind, string> = { agents: "Agents", tasks: "Tasks", questions: "Questions", images: "Images", processes: "Processes", projects: "Bubbles" };
const HINTS: Record<WorkKind, string> = {
  agents: "j/k move · enter view · s stop · a archived · f find · esc close",
  tasks: "j/k move · ←/→ fold · c abandon · a archived · f find · esc close",
  questions: "j/k move · enter answer · a archived · f find · esc close",
  images: "j/k move · enter view · a archived · f find · esc close",
  processes: "j/k move · s stop · f find · esc close",
  projects: "j/k move · enter open · p pin · d delete · a archived · esc close",
};
const DAY_HELP = "Items last active on this day, newest first. Enter or ← folds the day away; Enter or → opens it again.";
const SECTION_HELP = "Archived items are retained. Enter or → expands; ← collapses. u restores an item to the list without resuming work.";
const RESTORED = "Restored to list. No work resumed or questions reopened.";
const NO_PAGE = "open a conversation first";

/** What the page needs from the app. */
export interface WorkHost {
  deps: AppDeps; clock: Clock; questions: Questions;
  page(): Page | undefined; pages(): Page[]; valid(page: Page): boolean;
  draw(): void; reprint(): void;
  /** Close what cannot stay open under the page (menus, help, a pending clear). */
  opening(): void;
  /** The composer buffer: the answer being typed while a question's answer is open. */
  input(): { text: string; cursor: number }; edit(k: Key): void;
  noteRow(page: Page | undefined): string | undefined;
  /** Vim's `:` line while it is being typed, and its mode tag ("[NORMAL] ") when Vim keys are on. */
  commandLine(): string | undefined; modeTag(): string;
  images(page: Page): { rows: DeliveredMedia[]; archived: Record<string, boolean> } | undefined;
  readImages(page: Page): Promise<void>; retryImages(page: Page): Promise<void>;
  taskCountChanged(page: Page): Promise<void>;
  attach(page: Page, name: string, live: boolean): Promise<void>;
  openPage(project: string): Promise<unknown>; closePage(index: number): void; newPage(directory: string, bubble: string | null): Promise<void>;
}

interface Item extends WorkRow {
  sections: WorkSection[]; archived?: boolean; section?: true; heading?: true;
  agent?: AgentInfo; media?: DeliveredMedia; question?: Question; project?: ProjectEntry; watch?: processes.WatchRow; command?: processes.CommandRow; session?: processes.SessionRow;
}
interface View {
  kind: WorkKind; page?: Page;
  selected: Partial<Record<WorkKind, string>>; history: Partial<Record<WorkKind, boolean>>; detailTop: number;
  agents: AgentInfo[]; tasks: Awaited<ReturnType<typeof allTasks>>; collapsed: Set<string>; nodes: OutlineNode[];
  /** Per tab other than Tasks (whose folds are `collapsed`): the headings folded away. */
  folded: Map<WorkKind, Set<string>>;
  /** Why the task registry cannot be drawn as an outline (it is valid again once this is unset). */
  invalid?: string;
  hiddenQuestions: Record<string, boolean>; projects: ProjectEntry[]; parent?: string;
  /** What runs in the background for this conversation: watched pull requests and commands. */
  background: processes.ProcessView;
  /** Per listed conversation: the bubble it shares with others (what its orchestrators know in common). */
  bubbles: Record<string, { id: string; name: string; size: number }>;
  loaded: Set<WorkKind>; reads: Map<WorkKind, Promise<void>>; again: Set<WorkKind>; errors: Partial<Record<WorkKind, string>>;
  notice?: string; confirm?: { text: string; run: () => Promise<void> }; busy?: boolean;
  /** The find being typed (`from`: the selection Esc restores), and the last kept text for n/N. */
  find?: { text: string; from?: string }; query: string;
  /** The option row under the cursor while an answer is chosen; when the last `g` was pressed. */
  option: number; g: number;
  render?: WorkPageRender;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** The time of day alone: the rows already sit under their day's heading. */
const timeOf = (at: string | number) => { const text = formatDateTime(at); return text.slice(text.lastIndexOf(", ") + 2); };
/** A worker checkout by its own name (the folder under the home's worktrees), anything else with the home as ~. */
const shortFolder = (path: string) => /\/worktrees\/[^/]+\/([^/]+)$/.exec(path)?.[1] ?? path.replace(homedir(), "~");

/** What the watcher last saw of a PR, as one word or two and its colour. */
function watchStatus(state: Record<string, string> | null): { status: string; color: number } {
  if (!state) return { status: "watching", color: 90 };
  if (state.mergeable === "conflicting") return { status: "conflicts", color: 31 };
  if (state.checks === "failed") return { status: "checks failed", color: 31 };
  if (state.review === "CHANGES_REQUESTED") return { status: "changes asked", color: 33 };
  return state.checks === "passed" ? { status: "checks passed", color: 32 } : { status: "open", color: 33 };
}
/** The Processes tab's rows: the watched pull requests, then the background commands, each group under a heading. */
function processItems(view: processes.ProcessView, now: number): Item[] {
  const heading = (id: string, name: string, text: string): Item => ({ id, name, heading: true, sections: [{ title: name, text }] });
  const watches = view.watches.map((watch): Item => {
    const state = watch.state ?? {};
    return { id: `watch:${watch.repository}#${watch.number}`, name: `PR #${watch.number} ${watch.tasks.map(t => t.name).join(", ") || watch.repository}`, ...watchStatus(watch.state),
      info: watch.tasks.map(t => t.branch).join(", "), watch,
      sections: [{ title: `PR #${watch.number}`, fields: [["url", watch.url, watch.url]] },
        { title: "Watched for", text: watch.tasks.map(t => `#${t.number ?? "?"} ${t.name} (${t.branch})`).join("\n") || "no task: watched on request" },
        { title: "Last seen", fields: watch.state ? (["checks", "failing", "review", "mergeable", "head"] as const).flatMap((key): [string, string][] => state[key] ? [[key, key === "head" ? state[key]!.slice(0, 12) : state[key]!]] : []) : [], ...(watch.state ? {} : { text: "not looked at yet" }) }] };
  });
  const commands = view.commands.map((command): Item => {
    const p = command.record, started = Date.parse(p.createdAt), end = command.live ? now : Date.parse(p.updatedAt);
    const fields: [string, string, string?][] = [["owner", p.custody?.owner ?? p.owner], ...(p.custody ? [["started by", p.owner] as [string, string]] : []),
      ["folder", shortFolder(p.cwd)], ["started", formatDateTime(p.createdAt)], ["state", p.state], ...(p.exitCode === undefined ? [] : [["exit code", String(p.exitCode)] as [string, string]]),
      ...(p.reason ? [["reason", p.reason] as [string, string]] : []), ...(p.readyUrl ? [["url", p.readyAt ? p.readyUrl : `${p.readyUrl} (not ready yet)`, p.readyUrl] as [string, string, string]] : [])];
    return { id: p.id, name: p.command.replace(/\s+/g, " ").trim(), status: p.state, color: command.live ? 36 : p.state === "exited" ? 90 : 31,
      info: [p.custody?.owner ?? p.owner, Number.isFinite(end - started) ? formatElapsed(end - started) : ""].filter(Boolean).join(" · "), command,
      sections: [{ title: "Command", text: p.command }, { title: "Run", fields }, { title: "Output (last lines)", text: command.tail || "no output yet" }] };
  });
  // A session an agent opened with tmux itself: no record, so what tmux says about its windows is all there is.
  const sessions = view.sessions.map((session): Item => {
    const live = session.windows.filter(w => w.live), text = (w: processes.SessionRow["windows"][number]) => w.command.replace(/\s+/g, " ").trim() || "shell";
    return { id: `session:${session.name}`, name: session.windows.map(w => `${w.window}: ${text(w)}`).join(" · "), status: live.length ? "tmux" : "ended", color: live.length ? 36 : 90,
      info: [session.name, Number.isFinite(session.createdAt) ? formatElapsed(now - session.createdAt) : ""].filter(Boolean).join(" · "), session,
      sections: [{ title: "tmux session", fields: [["name", session.name], ["started", Number.isFinite(session.createdAt) ? formatDateTime(session.createdAt) : "unknown"], ["windows", String(session.windows.length)]] },
        ...session.windows.map(w => ({ title: `${w.window} · ${w.live ? "running" : "ended"}`, text: [text(w), w.path, w.tail].filter(Boolean).join("\n") }))] };
  });
  return [...(watches.length ? [heading(":watches", "PR watches", "Pull requests the orchestrator is told about when they change: checks, reviews, conflicts, a merge. s stops listening to the selected one."), ...watches] : []),
    ...byDay(commands, item => item.command!.live ? now : Date.parse(item.command!.record.updatedAt), now).map((item): Item => "sections" in item ? item
      : heading(`:commands${item.id}`, `Commands · ${item.name}`, "Background commands agents started, such as a local stack or a long check, by when they last ran. s stops the selected one, like Ctrl+C.")),
    ...(sessions.length ? [heading(":sessions", "tmux sessions", "Sessions agents opened with tmux themselves, in this conversation's folders. s ends the selected one."), ...sessions] : [])];
}

export class WorkPages {
  private view: View | null = null;
  constructor(private readonly host: WorkHost) {}

  get kind(): WorkKind | undefined { return this.view?.kind; }
  get open(): boolean { return !!this.view; }
  /** A y/n question owns the keys: chords and Vim letters wait. */
  get confirming(): boolean { return !!this.view?.confirm; }
  /** The bottom line is a text input (find, or a typed answer): letters are text, not commands. */
  get typing(): boolean { return !!this.view && (!!this.view.find || this.form(this.view) && this.host.questions.answering()); }

  /** What the page shows now, for tests and diagnostics; the screen is drawn from the same items. */
  get state(): { kind: WorkKind; items: WorkRow[]; index: number; notice?: string; confirm?: string; find?: string; query: string; option: number } | null {
    const view = this.view;
    if (!view) return null;
    const items = this.items(view);
    return { kind: view.kind, items, index: this.index(view, items), notice: view.notice, confirm: view.confirm?.text, find: view.find?.text, query: view.query, option: view.option };
  }

  /** A page chord: open on that tab, switch to it, or close when it is already showing. */
  toggle(kind: WorkKind): void {
    if (this.view?.kind === kind) return this.close();
    this.show(kind);
  }

  show(kind: WorkKind): void {
    const page = this.host.page();
    if (this.view) return this.tab(this.view, kind);
    this.host.opening();
    const view: View = this.view = { kind, page, selected: {}, history: {}, detailTop: 0, agents: [], tasks: [], collapsed: new Set(), nodes: [], folded: new Map(),
      hiddenQuestions: {}, projects: [], background: { watches: [], commands: [], sessions: [] }, bubbles: {}, loaded: new Set(), reads: new Map(), again: new Set(), errors: {}, query: "", option: 0, g: -Infinity };
    for (const each of WORK_KINDS) void this.read(view, each);
    this.host.draw();
  }

  close(): void {
    const view = this.view;
    if (!view) return;
    if (view.page && view.page.questions.expanded) this.host.questions.hide(view.page);
    this.view = null;
    this.host.reprint();
  }

  /** The active conversation changed: Projects is not about one conversation and stays; the other tabs close. */
  pageChanged(): void {
    const view = this.view;
    if (!view || view.page === this.host.page()) return;
    if (view.kind !== "projects") return this.close();
    Object.assign(view, { page: this.host.page(), agents: [], tasks: [], background: { watches: [], commands: [], sessions: [] }, hiddenQuestions: {}, selected: { projects: view.selected.projects }, loaded: new Set(["projects"]) });
    for (const each of WORK_KINDS) if (each !== "projects") void this.read(view, each);
    this.host.draw();
  }

  /** The app's poll: the agent list, or the background work, is re-read while it shows. */
  poll(): void {
    const view = this.view;
    if ((view?.kind === "agents" || view?.kind === "processes") && !view.busy && !view.confirm) void this.read(view, view.kind);
  }

  /** Re-read one tab's rows when the page is open (for `page`, when given). */
  refresh(kind: WorkKind, page?: Page): Promise<void> {
    const view = this.view;
    return view && (!page || view.page === page) && !(view.busy && kind === "tasks") ? this.read(view, kind) : Promise.resolve();
  }

  // --- data -------------------------------------------------------------------

  /** One read per tab at a time; a request during a read gets one trailing pass. */
  private read(view: View, kind: WorkKind): Promise<void> {
    const running = view.reads.get(kind);
    if (running) { view.again.add(kind); return running; }
    const run = (async () => {
      do { view.again.delete(kind); await this.load(view, kind); } while (view.again.has(kind) && this.view === view);
    })().finally(() => view.reads.delete(kind));
    view.reads.set(kind, run);
    return run;
  }

  private async load(view: View, kind: WorkKind): Promise<void> {
    const page = view.page, { deps } = this.host;
    try {
      if (kind === "projects") {
        const rows = await directories.projectRows(view.parent), bubbles = await conversationBubbles(rows);
        if (this.view === view) Object.assign(view, { projects: rows, bubbles });
      } else if (!page) return;
      else if (kind === "agents") { const rows = await (deps.agents ?? listAgents)(page.project); if (view.page === page) view.agents = rows; }
      else if (kind === "tasks") { const rows = await (deps.treeTasks ?? allTasks)(page.project); if (view.page === page) view.tasks = rows; }
      else if (kind === "processes") { const rows = await processes.processView(page.project, undefined, deps.sessions); if (view.page === page) view.background = rows; }
      else if (kind === "questions") { await this.host.questions.refresh(page); view.hiddenQuestions = workViews.workArchive(page.project, "questions"); }
      else await this.host.readImages(page);
      delete view.errors[kind];
    } catch (error) { view.errors[kind] = `${TITLES[kind]} unavailable: ${message(error)}`; }
    finally { view.loaded.add(kind); if (this.view === view) this.host.draw(); }
  }

  /** The tab's rows; `unfolded` ignores folded days and task subtrees (for counts, which must not change on a fold). */
  private items(view: View, kind = view.kind, unfolded = false): Item[] {
    const page = view.page, history = !!view.history[kind], folds = unfolded ? new Set<string>() : this.folds(view, kind);
    if (kind === "projects") return withArchiveSection(this.projectItems(view), history, folds)
      .map((item): Item => "sections" in item ? item : { ...item, sections: [{ title: item.name, text: "Deleted conversations. Nothing in them runs and their files are kept until orca clean. u restores the selected one." }] });
    if (!page) return [];
    if (kind === "processes") return withArchiveSection(processItems(view.background, this.host.clock.now()), false, folds) as Item[]; // nothing here is archived
    const now = this.host.clock.now();
    // Listed rows newest first under a heading per day; archived rows keep their own section below.
    const section = (items: Item[], at: (item: Item) => number) => withArchiveSection([...byDay(items.filter(item => !item.archived), at, now), ...items.filter(item => item.archived)], history, folds)
      .map((item): Item => "sections" in item ? item : { ...item, sections: [{ title: item.name, text: "heading" in item ? DAY_HELP : SECTION_HELP }] });
    if (kind === "tasks") return this.taskItems(view, history, unfolded);
    if (kind === "images") {
      const list = this.host.images(page);
      return section((list?.rows ?? []).map((media): Item => ({
        id: media.id, name: media.text.split("\n")[0] || media.id.slice(0, 8), status: media.kind, info: `${media.from} · ${timeOf(media.at)}`,
        sections: [{ title: "File", fields: [["from", media.from], ["at", formatDateTime(media.at)]] }, ...(media.text.includes("\n") ? [{ title: "Caption", text: media.text }] : [])],
        media, archived: list?.archived[media.id] ?? media.archived,
      })), item => Date.parse(item.media!.at));
    }
    if (kind === "questions") return section((page.questions.all ?? page.questions.open).map(question => this.questionItem(view, question)), item => Date.parse(item.question!.ts));
    return section(view.agents.filter(agent => agent.status !== "unknown").map((agent): Item => {
      const ms = elapsedMs(agent, now), queued = `${agent.queuedMessages ?? "?"} queued messages`;
      return { id: agent.name, name: agent.name, status: agent.live ? "running" : agent.archived ? "archived" : "exited", color: agent.live ? 33 : 90,
        info: [ms === null ? undefined : (agent.approximateEnd ? "~" : "") + formatElapsed(ms), agent.activity].filter(Boolean).join(" · "),
        sections: [{ title: "Now", text: agent.activity ?? "" }, { title: "Run", fields: [...(agent.startedAt ? [["started", formatDateTime(agent.startedAt)] as [string, string]] : []),
          ...(agent.endedAt ? [["exited", formatDateTime(agent.endedAt)] as [string, string]] : []), ...(agent.queuedMessages ? [["inbox", queued] as [string, string]] : [])] }],
        agent, archived: !agent.live && !agent.queuedMessages && (agent.archived || !recentAgent(agent, now)) };
    }), item => item.agent!.live ? now : Date.parse(item.agent!.lastActiveAt ?? item.agent!.endedAt ?? item.agent!.startedAt ?? ""));
  }

  private questionItem(view: View, question: Question): Item {
    const open = question.status === "open", options = question.options ?? [];
    const choosing = view.kind === "questions" && this.form(view) && view.page!.questions.selectedId === question.id && !this.host.questions.answering();
    const preset = options.indexOf(question.default ?? "");
    return { id: question.id, name: question.text.replace(/\s+/g, " "), status: question.status, color: open ? 33 : question.status === "answered" ? 32 : 90,
      info: `asked ${timeOf(question.ts)}`,
      sections: [{ title: "Question", text: question.text },
        ...(options.length ? [{ title: "Options", options: { items: open ? [...options, "Other…"] : options, cursor: choosing ? view.option : undefined, default: preset < 0 ? undefined : preset } }] : []),
        ...(open && !options.length && question.default ? [{ title: "Suggested answer", text: question.default }] : []),
        ...(question.answer ? [{ title: "Answer", text: question.answer }] : []), ...(question.reason ? [{ title: "Reason", text: question.reason }] : [])],
      question, archived: view.hiddenQuestions[question.id] ?? !open };
  }

  private taskItems(view: View, history: boolean, unfolded = false): Item[] {
    if (view.errors.tasks) return []; // an unreadable registry shows its error, never stale rows
    try {
      const { tasks, nodes, rows } = taskRows(view.tasks, unfolded ? new Set() : view.collapsed, history);
      if (!unfolded) { view.nodes = nodes; view.invalid = undefined; } // a count leaves the shown outline alone
      return rows.map((row): Item => {
        const task = row.section ? undefined : tasks.find(t => t.id === row.id);
        if (row.heading) return { ...row, sections: [{ title: row.name, text: "Tasks last touched on this day, newest first. A task moves here when it is worked on, its PR changes or it is edited. Enter or ← folds the day away; Enter or → opens it again." }] };
        return { ...row, archived: !!task?.removedAt, sections: task ? taskSections(tasks, task) : [{ title: "Archived", text: SECTION_HELP }] };
      });
    } catch (error) {
      // Only renderer-generated, fixed error messages cross this boundary; an invalid registry shows no outline.
      view.nodes = []; view.invalid = `Invalid task registry: ${message(error).slice(0, 256)}`;
      return [];
    }
  }

  private projectItems(view: View): Item[] {
    const pages = this.host.pages(), current = this.host.page()?.project;
    return view.projects.map((entry): Item => {
      const members = new Set([entry.name, ...(entry.conversations ?? [])]), open = pages.filter(page => members.has(page.project));
      const status = entry.archivedAt ? "archived" : open.some(page => page.busy) ? "turn" : current && members.has(current) ? "current" : open.length ? "open" : "";
      const bubble = view.bubbles[entry.name], shared = bubble && bubble.size > 1;
      return { id: entry.name, lead: entry.pinned ? "★ " : "", name: shared ? `${bubble.name} ▸ ${entry.label}` : entry.label, status, color: status === "turn" ? 33 : status === "current" ? 32 : 90,
        info: shared ? `bubble · ${bubble.size} orcs` : "",
        sections: [{ title: entry.directory ? "Project" : "Conversation", fields: [...(entry.directory ? [["folder", entry.directory] as [string, string]] : []),
          ...(bubble ? [["bubble", `${bubble.name} · shared by ${bubble.size} orchestrator${bubble.size === 1 ? "" : "s"}`] as [string, string]] : []),
          ...(entry.conversations ? [["chats", `${entry.conversations.length} conversations, ${open.length} open here`] as [string, string]] : []), ["pinned", entry.pinned ? "yes" : "no"]] }],
        project: entry, archived: !!entry.archivedAt };
    });
  }

  /** Whether a question's choose/answer form is up on the Questions tab. */
  private form(view: View): boolean {
    return view.kind === "questions" && !!view.page?.questions.expanded;
  }

  private index(view: View, items: Item[]): number {
    let id = view.selected[view.kind];
    if (id === undefined && view.kind === "projects") { const current = this.host.page()?.project ?? ""; id = view.projects.find(p => p.name === current || p.conversations?.includes(current))?.name; }
    const at = items.findIndex(item => item.id === id);
    if (at >= 0) return at;
    // Questions are answered oldest first: with nothing selected (or the selected one gone) the cursor is on the oldest open one, wherever newest-first puts it.
    const head = view.kind === "questions" ? items.findIndex(item => item.id === view.page?.questions.open[0]?.id) : -1;
    return head >= 0 ? head : Math.max(0, items.findIndex(item => !item.heading)); // never on a day heading
  }

  // --- drawing ----------------------------------------------------------------

  screen(): StickyScreen {
    const view = this.view!, { cols, rows } = this.host.deps.term, questions = view.page?.questions;
    // The form answers the selected question only: a question closed elsewhere, or another tab, puts it away.
    if (questions?.expanded && (view.kind !== "questions" || !questions.closing && !questions.open.some(q => q.id === questions.selectedId))) this.host.questions.hide(view.page!);
    const items = this.items(view), index = this.index(view, items), selected = items[index];
    if (selected && view.loaded.has(view.kind)) view.selected[view.kind] = selected.id;
    const footer = this.footer(view, cols);
    // A failed read is unknown, never a fabricated zero.
    const known = (kind: WorkKind) => view.loaded.has(kind) && (kind === "projects" || !!view.page) && !view.errors[kind] && !(kind === "questions" && (questions?.error || !questions?.loaded));
    const tabs = WORK_KINDS.map(kind => ({ name: TITLES[kind], count: known(kind) ? this.items(view, kind, true).filter(item => !item.section && !item.heading && !item.archived).length : undefined }));
    const empty = !view.page && view.kind !== "projects" ? NO_PAGE : !view.loaded.has(view.kind) ? "Loading…" : known(view.kind) ? `No ${view.kind}` : `${TITLES[view.kind]} unavailable`;
    const render = view.render = renderWorkPage({ cols, rows, tabs, active: WORK_KINDS.indexOf(view.kind), items, selected: index, empty,
      query: view.find?.text ?? view.query, sections: selected?.sections ?? [], detailTop: view.detailTop, footer: footer.line });
    view.detailTop = render.detail.top;
    return { rows: render.lines, cols, cursor: Math.max(0, rows - 1), col: footer.col, bodyTop: 0, bodyHeight: rows, start: 0, maxStart: 0 };
  }

  /** The page's one status line: Vim's `:`, a confirmation, an input, a notice, else the tab's key hints. */
  private footer(view: View, cols: number): { line: string; col: number } {
    const command = this.host.commandLine(), questions = view.page?.questions;
    if (command !== undefined) return inputLine(":", command, command.length, "enter run · esc cancel", cols);
    if (view.confirm) return { line: sanitize(`${view.confirm.text}  y confirm · n/esc cancel`), col: 0 };
    if (view.find) return inputLine("find › ", view.find.text, view.find.text.length, "enter keep · esc cancel · then n/N", cols);
    if (this.form(view) && questions) {
      if (questions.error) return { line: sanitize(`questions unavailable: ${questions.error}`), col: 0 };
      if (questions.closing) return { line: QUESTION_PROGRESS[questions.closing], col: 0 };
      const note = this.host.noteRow(view.page);
      if (note) return { line: note, col: 0 };
      const input = this.host.input(), count = questions.open.find(q => q.id === questions.selectedId)?.options?.length ?? 0;
      return this.host.questions.answering() ? inputLine("answer › ", input.text, input.cursor, "enter send · esc cancel", cols)
        : { line: `answer › ${dim(`j/k choose · 1–${count + 1} pick · enter send · esc cancel`)}`, col: 0 };
    }
    const hint = view.kind === "projects" && view.parent ? "j/k move · enter open · n new bubble · b new orc in this bubble · c close page · d delete · esc back" : HINTS[view.kind];
    const notice = this.host.noteRow(view.page) ?? view.notice ?? (view.kind === "questions" && questions?.error ? `questions unavailable: ${questions.error}` : view.errors[view.kind] ?? (view.kind === "tasks" ? view.invalid : undefined));
    return { line: this.host.modeTag() + (notice ? sanitize(notice) : dim(hint)), col: 0 };
  }

  // --- keys -------------------------------------------------------------------

  async key(k: Key): Promise<void> {
    const view = this.view;
    if (!view) return;
    const key = k.name === "char" ? k.text ?? "" : k.name, plain = !k.ctrl && !k.alt;
    if (view.busy) { if (key === "escape" && !view.confirm) this.close(); return; }
    if (view.confirm) return this.confirmKey(view, key, plain);
    const items = this.items(view), index = this.index(view, items);
    if (view.find) return this.findKey(view, k, items);
    if (this.form(view)) return this.formKey(view, k);
    view.notice = undefined;
    const g = key === "g" && plain && this.host.clock.now() - view.g < 1500;
    view.g = key === "g" && plain && !g ? this.host.clock.now() : -Infinity;
    if (key === "escape") {
      if (view.kind !== "projects" || !view.parent) return this.close();
      view.selected.projects = view.parent; Object.assign(view, { projects: [], parent: undefined }); view.loaded.delete("projects"); void this.read(view, "projects");
    } else if (k.ctrl && !k.alt && (k.name === "d" || k.name === "u")) this.move(view, items, index + (k.name === "d" ? 1 : -1) * Math.max(1, Math.floor(tableRows(this.host.deps.term.rows) / 2)));
    else if (!plain) return;
    else if (key === "mousedown") { const table = view.render?.table, row = (k.y ?? 0) - 1 - (table?.y ?? 0); if (table && row >= 0 && row < table.rows && items[table.top + row]) this.move(view, items, table.top + row); }
    else if (key === "j" || key === "down" || key === "wheeldown") this.move(view, items, index + 1);
    else if (key === "k" || key === "up" || key === "wheelup") this.move(view, items, index - 1);
    else if (g || key === "home") this.move(view, items, 0);
    else if (key === "G" || key === "end") this.move(view, items, items.length - 1);
    else if (key === "pageup" || key === "pagedown") view.detailTop += (key === "pageup" ? -1 : 1) * Math.max(1, (view.render?.detail.rows ?? 2) - 1);
    else if (/^[1-6]$/.test(key)) this.tab(view, WORK_KINDS[Number(key) - 1]!);
    else if (key === "tab") this.tab(view, WORK_KINDS[(WORK_KINDS.indexOf(view.kind) + (k.shift ? WORK_KINDS.length - 1 : 1)) % WORK_KINDS.length]!);
    else if (["h", "l", "left", "right"].includes(key)) this.sideways(view, items[index], key === "l" || key === "right");
    else if (key === "f" || key === "/") view.find = { text: "", from: items[index]?.id };
    else if ((key === "n" || key === "N") && !(key === "n" && view.kind === "projects" && view.parent)) {
      const hit = findItem(items, view.query, index + (key === "n" ? 1 : -1), key === "n" ? 1 : -1);
      if (hit === -1) view.notice = view.query ? `no item matches "${view.query}"` : "f starts a find; then n/N go to the next and previous match";
      else this.move(view, items, hit);
    }
    else if (key === "a" && view.kind !== "processes") { view.history[view.kind] = !view.history[view.kind]; view.selected[view.kind] = ARCHIVED_SECTION; view.detailTop = 0; }
    else if (key === "r") { view.notice = "Refreshing…"; this.host.draw(); await Promise.all(WORK_KINDS.map(kind => this.read(view, kind))); if (view.notice === "Refreshing…") view.notice = view.errors[view.kind] ? undefined : `Refreshed ${formatDateTime(this.host.clock.now())}`; }
    else if (key === "enter" && items[index]?.section) view.history[view.kind] = !view.history[view.kind];
    else if (key === "enter" && items[index]?.heading) { const folds = this.folds(view), id = items[index].id; if (!folds.delete(id)) folds.add(id); }
    else if (key === "t" && view.kind === "images" && view.page) await this.retry(view, view.page);
    else if (items[index] && !items[index].heading && view.page && view.kind !== "projects") await this.itemKey(view, view.page, key, items, items[index]);
    else if (items[index]?.project) await this.projectKey(view, key, items[index].project);
    if (this.view === view) this.host.draw();
  }

  /** Images, t: send again the image prompts whose delivery was never confirmed, under their original ids. */
  private async retry(view: View, page: Page): Promise<void> {
    view.busy = true; view.notice = "Retrying unconfirmed image prompts…"; this.host.draw();
    try { await this.host.retryImages(page); view.notice = "Retried unconfirmed image prompts."; }
    catch (error) { view.notice = message(error); }
    finally { view.busy = false; }
  }

  private move(view: View, items: Item[], to: number): void {
    // A heading is a row like the Archived one: the cursor rests on it, which is where its day is folded.
    view.selected[view.kind] = items[Math.max(0, Math.min(items.length - 1, to))]?.id;
    view.detailTop = 0;
  }

  private tab(view: View, kind: WorkKind): void {
    if (view.page?.questions.expanded) this.host.questions.hide(view.page);
    Object.assign(view, { kind, detailTop: 0, notice: undefined, confirm: undefined, find: undefined, query: "" });
    this.host.draw();
  }

  /** The headings folded away on a tab. */
  private folds(view: View, kind = view.kind): Set<string> {
    if (kind === "tasks") return view.collapsed;
    const folds = view.folded.get(kind) ?? new Set<string>();
    view.folded.set(kind, folds);
    return folds;
  }

  /** ←/→ and h/l: fold on Tasks, open or shut the Archived row or a day heading, else the previous or next tab. */
  private sideways(view: View, selected: Item | undefined, forward: boolean): void {
    if (selected?.section) view.history[view.kind] = forward;
    else if (selected?.heading && view.kind !== "tasks") { if (forward) this.folds(view).delete(selected.id); else this.folds(view).add(selected.id); }
    else if (view.kind === "tasks") { view.selected.tasks = navigateOutline(view.nodes, selected?.id, view.collapsed, forward ? "right" : "left"); view.detailTop = 0; }
    else this.tab(view, WORK_KINDS[(WORK_KINDS.indexOf(view.kind) + (forward ? 1 : WORK_KINDS.length - 1)) % WORK_KINDS.length]!);
  }

  private async confirmKey(view: View, key: string, plain: boolean): Promise<void> {
    if (/^(?:wheel|mouse)/.test(key)) return;
    const confirm = view.confirm!;
    if (plain && (key === "y" || key === "Y")) {
      view.busy = true;
      try { await confirm.run(); }
      catch (error) { view.notice = message(error); }
      finally { view.busy = false; view.confirm = undefined; }
    } else view.confirm = undefined;
    if (this.view === view) this.host.draw();
  }

  /** Every printable key is find text; the selection follows the first match from where the find started. */
  private findKey(view: View, k: Key, items: Item[]): void {
    const find = view.find!, text = typedText(k);
    if (k.name === "escape") { view.selected[view.kind] = find.from; view.find = undefined; view.query = ""; }
    else if (k.name === "enter") { view.query = find.text; view.find = undefined; }
    else if (k.name === "backspace" || text) {
      find.text = text ? find.text + text.replace(/[\r\n]/g, " ") : [...find.text].slice(0, -1).join("");
      const from = Math.max(0, items.findIndex(item => item.id === find.from)), hit = findItem(items, find.text, from);
      view.selected[view.kind] = items[hit === -1 ? from : hit]?.id;
    } else return;
    view.detailTop = 0;
    this.host.draw();
  }

  /** Enter on an open question: its options to choose from (starting on the default), or straight to a typed answer. */
  private async openQuestion(view: View, page: Page, question: Question): Promise<void> {
    if (question.status !== "open") { view.notice = "Closed question; saved answer and reason are shown in details."; return; }
    page.view?.leave();
    const reading = this.host.questions.command(page, question.id), q = page.questions, options = question.options ?? [];
    if (options.length && q.expanded) {
      view.option = this.host.questions.answering() ? options.length : Math.max(0, options.indexOf(question.default ?? ""));
      q.index = 0;
      this.host.questions.sync();
    }
    this.host.draw();
    await reading;
  }

  /** Choosing an option or typing the answer; every send goes through the questions controller. */
  private async formKey(view: View, k: Key): Promise<void> {
    const page = view.page!, q = page.questions, controller = this.host.questions;
    const key = k.name === "char" ? k.text ?? "" : k.name, plain = !k.ctrl && !k.alt;
    if (key === "escape" && plain && !k.shift) { controller.hide(page); return this.host.draw(); }
    if (q.error || q.closing) return;
    const before = q.open.map(item => item.id).join(), count = q.open.find(item => item.id === q.selectedId)?.options?.length ?? 0;
    const remove = k.name === "d" && !!k.ctrl && !k.alt;
    if (controller.answering()) {
      if (remove || controller.takes(k) && !["up", "down", "tab"].includes(k.name)) await controller.handle(k);
      else if (!["up", "down", "tab"].includes(k.name)) this.host.edit(k);
    } else if (remove) await controller.handle(k);
    else if (!plain) return;
    else if (key === "j" || key === "down") view.option = Math.min(count, view.option + 1);
    else if (key === "k" || key === "up") view.option = Math.max(0, view.option - 1);
    else if (/^[1-9]$/.test(key) && Number(key) <= count) await controller.handle(k);
    else if (key === String(count + 1) || key === "enter" && view.option === count) controller.startAnswer(page);
    else if (key === "enter") { q.index = view.option; await controller.handle(k); }
    if (before !== q.open.map(item => item.id).join()) { controller.hide(page); await this.read(view, "questions"); }
    if (this.view === view) this.host.draw();
  }

  /** A key on a conversation's item (agent, task, question, image). */
  private async itemKey(view: View, page: Page, key: string, items: Item[], selected: Item): Promise<void> {
    const { deps } = this.host, kind = view.kind, agent = selected.agent;
    const task = kind === "tasks" ? view.tasks.find(t => t.id === selected.id) : undefined;
    const work = async (run: () => Promise<void>) => {
      view.busy = true;
      try { await run(); } catch (error) { view.notice = message(error); } finally { view.busy = false; }
    };
    if (kind === "processes") {
      // s is Ctrl+C for that one command, or stops listening to that pull request; the orchestrator is told either way.
      const { watch, command, session } = selected, live = command?.live;
      if (key !== "s" || !watch && !command && !session) return;
      if (command && !live) { view.notice = "That command has already ended."; return; }
      view.confirm = { text: watch ? `Stop watching PR #${watch.number}?` : session ? `End tmux session ${session.name} (${session.windows.length} windows)?` : "Stop this command?", run: async () => {
        if (watch) await processes.stopWatch(page.project, watch); else if (session) await processes.stopSession(page.project, session.name, deps.sessions); else await processes.stopCommand(page.project, command!.record.id);
        await this.read(view, "processes");
        view.notice = watch ? "Watch stopped. The orchestrator was told." : session ? "Session ended. The orchestrator was told." : "Stop requested. The orchestrator was told.";
      } };
      return;
    }
    if (key === "u" && selected.archived && !selected.section) return work(async () => {
      if (agent) await (deps.restoreAgents ?? restoreAgents)(page.project, [agent.name]);
      else if (task) { await restoreTask(page.project, task.id); await this.host.taskCountChanged(page); }
      else if (kind === "questions" || kind === "images") workViews.setWorkArchived(page.project, kind, [selected.id], false);
      await this.read(view, kind);
      view.notice = RESTORED;
    });
    if (key === "enter" && selected.media) return work(async () => { view.notice = await (deps.openMedia ?? openDeliveredMedia)(page.project, selected.media!); });
    if (key === "enter" && selected.question) return this.openQuestion(view, page, selected.question);
    if (key === "enter" && agent) { this.close(); page.view?.leave(); await this.host.attach(page, agent.name, agent.live); return this.host.reprint(); }
    if (kind === "tasks") return this.taskKey(view, page, key, task);
    if (key !== "d" && key !== "D" && !(key === "s" && agent)) return;
    if (kind === "agents") return this.agentKey(view, page, key, agent);
    const targets = (key === "D" ? items : [selected]).filter(item => !item.section && !item.heading && !item.archived);
    if (!targets.length) { view.notice = "No items to archive."; return; }
    view.confirm = { text: `Archive ${targets.length} ${kind}?${kind === "questions" ? " Open questions will be dismissed without an answer." : " Files retained."}`, run: async () => {
      for (const item of targets) {
        if (item.question?.status === "open") await (deps.questions ?? fileStore).skip(page.project, item.id);
        workViews.setWorkArchived(page.project, kind as "questions" | "images", [item.id], true);
      }
      await this.read(view, kind);
      view.notice = "Archived. Saved records retained.";
    } };
  }

  private async agentKey(view: View, page: Page, key: string, agent: AgentInfo | undefined): Promise<void> {
    const { deps } = this.host, project = page.project;
    if (key === "s") {
      const run = agent?.run;
      if (!agent?.live || !run || agent.status !== "running") return;
      view.confirm = { text: `Stop ${agent.name}?`, run: async () => {
        if (launchIdentity(project, agent.name) !== run) throw new Error("The selected run changed. Refresh and try again.");
        await (deps.cancelAgent ?? cancelSession)(project, agent.name, run);
        const commands = await listProcesses(project);
        await Promise.all(commands.filter(p => p.owner === agent.name && p.run === run && liveProcess(p)).map(async p => {
          try { await controlProcess(project, p.id, "stop"); }
          catch (error) { if ((await listProcesses(project)).some(current => current.id === p.id && liveProcess(current))) throw error; }
        }));
        await this.read(view, "agents");
        view.notice = "Stop requested. Refresh to verify the exit.";
      } };
      return;
    }
    const eligible = (row: AgentInfo) => row.status === "exited" && !row.live && !row.archived && row.queuedMessages === 0;
    const candidates = (key === "D" ? view.agents : agent ? [agent] : []).filter(eligible);
    const blocked = new Set((await listProcesses(project)).filter(p => unresolvedProcess(p)).map(p => processOwner(p)));
    const runs = new Map(candidates.filter(row => !blocked.has(row.name)).map(row => [row.name, row.run]));
    const names = [...runs.keys()];
    if (this.view !== view) return;
    if (!names.length) { view.notice = "No eligible finished agents."; return; }
    view.confirm = { text: key === "D" ? `Archive ${names.length} finished agents?` : `Archive ${names[0]}?`, run: async () => {
      const current = await (deps.agents ?? listAgents)(project), commands = await listProcesses(project);
      const safe = current.filter(row => runs.has(row.name) && runs.get(row.name) === row.run && eligible(row) &&
        !commands.some(p => processOwner(p) === row.name && unresolvedProcess(p))).map(row => row.name);
      const result = await (deps.archiveAgents ?? archiveAgents)(project, safe);
      await this.read(view, "agents");
      view.notice = `Archived ${result.archived.length} of ${names.length} agents. Transcripts retained.`;
    } };
  }

  private async taskKey(view: View, page: Page, key: string, task: View["tasks"][number] | undefined): Promise<void> {
    if (!view.loaded.has("tasks") || view.errors.tasks || view.invalid) return;
    const archivable = (t: View["tasks"][number]) => canArchiveTask(t) && !t.removedAt;
    if (key === "c" && task && !task.archive) {
      const runs = task.runs.filter(run => !run.endedAt && (run.state === "prepared" || run.state === "started"));
      const dependents = view.tasks.filter(t => t.dependsOn?.includes(task.id));
      if (runs.length) view.notice = `Stop ${runs.length} active or queued runs first.`;
      else if (task.pr && task.publication?.state !== "CLOSED") view.notice = `Resolve PR #${task.pr.number} before abandoning.`;
      else view.confirm = { text: `Abandon task? ${dependents.length} dependents retained.`, run: async () => {
        await abandonTask(page.project, task.id, task.revision);
        await this.read(view, "tasks");
        view.notice = "Task abandoned. Ledger and dependencies retained.";
      } };
    } else if (key === "d" || key === "D") {
      const ids = (key === "D" ? view.tasks : task ? [task] : []).filter(archivable).map(t => t.id);
      if (!ids.length) { view.notice = key === "D" ? "No settled tasks to archive." : "Only merged or abandoned/closed tasks with no active runs or open PR can be archived."; return; }
      view.confirm = { text: `Archive ${ids.length} settled task(s)?`, run: async () => {
        try { for (const id of ids) await (this.host.deps.removeTask ?? removeTask)(page.project, id, true); }
        catch (error) { throw new Error(`Removal refused: ${message(error)}`); }
        finally { await this.read(view, "tasks"); await this.host.taskCountChanged(page); }
        view.notice = "Archived; task memory and dependencies retained.";
      } };
    }
  }

  /** Projects: Enter opens (a directory project lists its conversations first), p pins, c closes an open page, d deletes after y/n, n starts a conversation in the listed project. */
  private async projectKey(view: View, key: string, entry: ProjectEntry): Promise<void> {
    const pages = this.host.pages();
    if (entry.archivedAt) {
      // An archived conversation only comes back: nothing in it opens or runs until it is restored.
      if (key !== "u") { if (["enter", "d", "D", "p", "c", "b"].includes(key)) view.notice = `${entry.label} is archived; u restores it`; return; }
      try { await retire.restoreProject(entry.name); await this.read(view, "projects"); view.notice = `restored ${entry.label}; nothing was started`; }
      catch (error) { view.notice = message(error); }
    } else if (key === "enter") {
      if ((await directories.directoryProjects()).some(p => p.id === entry.name)) {
        Object.assign(view, { parent: entry.name, projects: [], query: "" }); view.selected.projects = undefined; view.loaded.delete("projects");
        return this.read(view, "projects");
      }
      this.close();
      try { await this.host.openPage(entry.name); } catch (error) { view.notice = message(error); }
    } else if (key === "n" && view.parent) {
      const parent = (await directories.directoryProjects()).find(p => p.id === view.parent);
      this.close();
      if (parent) await this.host.newPage(parent.directory, null);
    } else if (key === "b" && view.parent && !entry.directory) {
      // Another orchestrator for the same bubble: a new conversation in this folder that shares this one's memory, notebook and behavior.
      const parent = (await directories.directoryProjects()).find(p => p.id === view.parent);
      if (!parent) return;
      const bubble = await ensureBubble(entry.name, entry.label);
      this.close();
      await this.host.newPage(parent.directory, bubble.id);
    } else if (key === "p") {
      const on = await togglePin(entry.name);
      await this.read(view, "projects");
      view.notice = `${on ? "pinned" : "unpinned"} ${entry.label}`;
    } else if (key === "c") {
      const current = this.host.page();
      const page = pages.find(p => p.project === entry.name) ?? (current && entry.conversations?.includes(current.project) ? current : undefined);
      if (!page) { view.notice = `${entry.label} has no open page`; return; }
      this.host.closePage(pages.indexOf(page));
      if (this.view === view) view.notice = `closed ${page.name}; its project and history are kept`;
    } else if (key === "d" || key === "D") {
      // Delete works up from the bottom: agents and commands are asked to stop and waited for, what the conversation
      // owns is archived, then the conversation is. Nothing is removed from disk; orca clean does that later.
      // d: this conversation, or every conversation of a folder row. D: every conversation sharing this one's bubble.
      const bubble = key === "D" ? view.bubbles[entry.name] : undefined;
      if (key === "D" && !bubble) { view.notice = `${entry.label} is in no bubble; d deletes it`; return; }
      const what = bubble ? `bubble ${bubble.name} and its ${bubble.size} orc${bubble.size === 1 ? "" : "s"}` : entry.label;
      const confirm = { text: `delete ${what}?`, run: async () => {
        const options = { ...this.host.deps.projects, sessions: this.host.deps.sessions, beforeArchive: (project: string) => {
          const page = this.host.pages().find(p => p.project === project);
          if (page) this.host.closePage(this.host.pages().indexOf(page));
        } };
        view.notice = `stopping what runs under ${what}…`; this.host.draw();
        let reports: Awaited<ReturnType<typeof archiveFolder>> = [];
        try { reports = bubble ? await archiveBubble(bubble.id, options) : entry.directory ? await archiveFolder(entry.conversations ?? [], options) : [await archiveProject(entry.name, options)]; }
        finally { await this.read(view, "projects"); }
        view.notice = [`deleted ${what}`, retire.describeArchive(reports), "kept until orca clean; a then u restores"].filter(Boolean).join(" · ");
      } };
      view.confirm = confirm;
      void deletionSummary(entry).then(holding => {
        if (view.confirm !== confirm || bubble) return;
        if (holding) confirm.text = `delete ${what} (${holding}; running work is stopped, everything is archived)?`;
        if (this.view === view) this.host.draw();
      }, () => { /* the archive's own checks report what cannot be read */ });
    }
  }
}

/** The bubble of each listed conversation that has one, with how many conversations share it. */
async function conversationBubbles(rows: ProjectEntry[]): Promise<Record<string, { id: string; name: string; size: number }>> {
  const out: Record<string, { id: string; name: string; size: number }> = {};
  for (const row of rows) {
    if (row.directory) continue;
    let id: string | null = null;
    try { id = peekBubble(row.name); } catch { /* an unreadable conversation is listed without its bubble */ }
    const bubble = id ? await readBubble(id) : null;
    if (bubble) out[row.name] = { id: bubble.id, name: bubble.name, size: bubbleMembers(bubble.id).length };
  }
  return out;
}
