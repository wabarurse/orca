// Explicitly opened questions in the composer-first TUI. Arrivals only update
// the count; Ctrl+Q or /questions opens the oldest question BELOW the input.
// Esc/Tab/Ctrl+Q closes without answering/skipping and restores the saved chat
// draft; a typed answer remains with the question for reopening. Selecting
// skip and pressing Enter is the only skip action. Menus take precedence.
//
// Modes: pick (options/skip, empty input); answer (answer> edits the answer);
// chat (panel closed, empty queue, or an agent view). Opening saves the chat
// buffer, even when it is nonempty. If a question is closed elsewhere, its
// orphaned answer is reported separately and the ORIGINAL chat is restored;
// neither buffer is silently replaced or moved to the next question.
// Enter/digits/typing have a short guard after opening. The #45 closing guard
// keeps polls from mistaking our own in-flight answer for an external close.
// A local answer's history line waits behind any streaming partial in app.ts.

import { stat } from "node:fs/promises";
import { paths } from "../config";
import * as store from "../questions";
import * as ed from "./editor";
import type { EditState } from "./editor";
import type { Key } from "./keys";
import type { Line } from "./lines";
import { dim, type QuestionMode, type QuestionView } from "./render";
import { answeredLine, questionReply, type AskedLookup } from "./restore";

type Question = store.Question;

/** What the TUI reads and closes questions with; tests stub it. `stamp` changes whenever the questions dir does. */
export interface QuestionStore {
  stamp(project: string): Promise<number>;
  /** Every question, answered and skipped too (for replies the orchestrator reads, and restore). */
  all(project: string): Promise<Question[]>;
  list(project: string): Promise<Question[]>;
  answer(project: string, id: string, text: string): Promise<unknown>;
  skip(project: string, id: string): Promise<unknown>;
}

export const fileStore: QuestionStore = {
  stamp: (project) => stat(paths.questions(project)).then((s) => s.mtimeMs, () => -1),
  all: store.all,
  list: store.list,
  answer: store.answer,
  skip: store.skip,
};

/**
 * A stamp older than this at the last read is trusted: an mtime can miss a
 * change in the same tick as the read before it, so a young one is re-read.
 */
const SETTLE_MS = 1000;

/** One page's questions. */
export interface PageQuestions {
  /** Open questions, oldest first, as of the last read. */
  open: Question[];
  /** Every question seen, by id (answered and skipped ones from the first read too), to read replies by their question's own text. */
  seen: Map<string, Question>;
  /** The questions dir's stamp at the last read, and when that read started (wall clock). */
  stamp: number;
  readAt: number;
  /** The read in flight, if any; polls never overlap. */
  polling: Promise<void> | null;
  /** Ids hidden on close; expanded is the explicit open/closed state. */
  hidden: Set<string> | null;
  expanded: boolean;
  /** The selected row of the shown question: an option, then "type your own answer", then "skip". */
  index: number;
  /** The answer typed so far, while the input shows something else. */
  answer: EditState;
  /** The head question last shown, and until when (host clock) Enter, digits and typing are ignored. */
  shownHead: string | undefined;
  readyAt: number;
  /** An answer or skip in flight. */
  closing: boolean;
  /** Ids answered or skipped here: already on screen when the orchestrator reads them, and never shown again by a stale read. */
  mine: Set<string>;
}

/** What the controller needs of a page; `view` is set while it shows an agent's transcript. */
export interface QuestionPage { project: string; name: string; questions: PageQuestions; view?: unknown }

/** What the controller needs from the app. */
export interface QuestionHost {
  page(): QuestionPage | undefined;
  input: EditState;
  /** Columns the answer's text gets (the screen less the prompt), for ↑↓ between its lines. */
  width(): number;
  now(): number;
  /** A note: on screen now, in an agent view too. */
  say(line: string, page: QuestionPage): void;
  /** A line of the page's own history (an answered question), as the orchestrator's transcript will show it. */
  record(line: string, page: QuestionPage): void;
  /** Whether the text's first word is a command the app knows, and running it as if typed in chat. */
  isCommand(text: string): boolean;
  run(text: string): Promise<void>;
  draw(): void;
}

const EMPTY: EditState = { text: "", cursor: 0 };
/** How long Enter, digits and typing are ignored after a question first shows. */
export const QUESTION_DELAY_MS = 500;

export const pageQuestions = (): PageQuestions => ({ open: [], seen: new Map(), stamp: NaN, readAt: 0, polling: null, hidden: null, expanded: false, index: 0, answer: EMPTY, shownHead: undefined, readyAt: 0, closing: false, mine: new Set() });

type Mode = "chat" | QuestionMode;
/** What the input holds in a mode: the chat draft, the question's answer, or nothing (a row is being picked). */
const bufferOf = (m: Mode) => (m === "chat" ? "chat" : m === "answer" ? "answer" : "none");

const head = (q: PageQuestions) => q.open[0];
const visible = (q: PageQuestions) => q.expanded && q.open.length > 0 && (!q.hidden || q.open.some((x) => !q.hidden!.has(x.id)));
const optionCount = (q: PageQuestions) => head(q)?.options?.length ?? 0;
/** The "type your own answer" row; "skip" is the one after it. */
const ownRow = (q: PageQuestions) => optionCount(q);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** questions.ts refuses a second close with "already …", and a removed question with "no question …". */
const closedElsewhere = (err: unknown) => /already|no question/.test(message(err));

/** Plain keys only: Ctrl, Alt and Shift chords never pick, put off or clear a question. */
const plain = (k: Key) => !k.ctrl && !k.alt && !k.shift;
/** Typed text (a printable run or a paste), as the input would insert it. */
const typing = (k: Key) => (k.name === "char" || k.name === "paste") && !k.ctrl && !k.alt;
/** The named keys a shown question takes. */
const TAKEN = new Set(["up", "down", "enter", "escape", "tab"]);

export class Questions {
  /** Which page's which mode the input was last synced to. */
  private shown: { page: QuestionPage | undefined; mode: Mode } = { page: undefined, mode: "chat" };
  /** The chat draft, while the input holds a question's answer. */
  private chat: EditState = EMPTY;

  constructor(private readonly host: QuestionHost, private readonly store: QuestionStore = fileStore, private readonly delayMs = QUESTION_DELAY_MS) {}

  // --- polling ----------------------------------------------------------------

  /** Every question of a page once, when it opens: replies are then read by their question's text. Returns the lookup for restore. */
  async load(page: QuestionPage): Promise<AskedLookup> {
    const seen = page.questions.seen;
    for (const x of await this.store.all(page.project).catch(() => [])) seen.set(x.id, x);
    return (id) => seen.get(id);
  }

  /** Re-read each page's open questions when its questions dir changed; one read per page at a time. */
  poll(pages: QuestionPage[]): void {
    for (const p of pages) this.pollPage(p);
  }

  private pollPage(page: QuestionPage): Promise<void> {
    const q = page.questions;
    q.polling ??= this.read(page).catch(() => {}).finally(() => { q.polling = null; });
    return q.polling;
  }

  private async read(page: QuestionPage): Promise<void> {
    const q = page.questions;
    const started = Date.now();
    const stamp = await this.store.stamp(page.project);
    if (stamp === q.stamp && q.readAt - stamp > SETTLE_MS) return;
    const open = (await this.store.list(page.project)).filter((x) => !q.mine.has(x.id));
    q.stamp = stamp;
    q.readAt = started;
    this.update(page, open);
  }

  private keepClosing(q: PageQuestions, open: Question[]): Question[] {
    const before = head(q);
    return q.closing && before && !open.some((x) => x.id === before.id) ? [before, ...open] : open;
  }

  /** Refresh the queue without opening it; a changed head starts at its first row. */
  private update(page: QuestionPage, open: Question[]): void {
    const q = page.questions;
    const before = head(q);
    // A read can see the head answered by the close still in flight here: it stays until that close ends.
    open = this.keepClosing(q, open);
    for (const x of open) q.seen.set(x.id, x);
    q.open = open;
    if (!open.length) q.expanded = false;
    if (q.hidden && open.some((x) => !q.hidden!.has(x.id))) q.hidden = null;
    if (before && !open.some((x) => x.id === before.id)) this.headGone(page, before);
    else if (head(q)?.id !== before?.id) this.reset(page);
    this.sync();
    this.host.draw();
  }

  /** A new head: first row, no answer typed. */
  private reset(page: QuestionPage): void {
    page.questions.index = 0;
    page.questions.answer = EMPTY;
    if (this.shown.page === page && this.shown.mode === "answer") this.host.input = EMPTY;
  }

  /** The head was answered elsewhere (seen by a read): quietly gone, unless an answer to it was typed. */
  private headGone(page: QuestionPage, h: Question): void {
    if (!this.typed(page).text.trim()) return this.reset(page);
    this.keepTyped(page, `"${h.text}" was answered elsewhere`);
  }

  /** The answer typed for the page's head: in the input while it shows, else put aside. */
  private typed(page: QuestionPage): EditState {
    return this.shown.page === page && this.shown.mode === "answer" ? this.host.input : page.questions.answer;
  }

  /** Preserve the original chat buffer; an orphaned answer is reported separately, never assigned to the next question. */
  private keepTyped(page: QuestionPage, note: string): void {
    const typed = this.typed(page);
    const active = this.shown.page === page && this.shown.mode !== "chat";
    page.questions.expanded = false;
    page.questions.index = 0;
    page.questions.answer = EMPTY;
    if (active) {
      this.host.input = this.chat;
      this.shown = { page, mode: "chat" };
    }
    if (typed.text.trim()) note += `; your unsent answer: ${typed.text}`;
    this.host.say(dim(note), page);
  }

  // --- what shows -------------------------------------------------------------

  /** The mode the active page wants now: what sync moves the input to. */
  private want(page = this.host.page()): Mode {
    if (!page || page.view || !visible(page.questions)) return "chat";

    return page.questions.index === ownRow(page.questions) ? "answer" : "pick";
  }

  /** The active page's shown question, for the frame. */
  view(): QuestionView | null {
    const page = this.host.page();
    const mode = this.want(page);
    const h = page && head(page.questions);
    if (mode === "chat" || !h) return null;
    const q = page.questions;
    return { text: h.text, options: h.options ?? [], index: q.index, ...(h.default ? { default: h.default } : {}), count: q.open.length, mode };
  }

  /** Whether the input is the shown question's answer ("answer>"). */
  answering(): boolean {
    return this.want() === "answer";
  }

  /** A "user" message the orchestrator read: a question's answer as its dim line, or nothing when it was answered here (already shown). Null for anything else. */
  inboxLines(page: QuestionPage, text: string): Line[] | null {
    const reply = questionReply(text, (id) => page.questions.seen.get(id));
    if (!reply) return null;
    return page.questions.mine.has(reply.id) ? [] : [reply.line];
  }

  /**
   * Put the right buffer in the input for the mode the active page wants, and
   * start the delay when a question first shows (a new head, or keys coming
   * back from chat). The app calls it on every draw.
   */
  sync(): void {
    const page = this.host.page();
    const want = this.want(page);
    if (this.shown.page === page && this.shown.mode === want) return;
    const from = bufferOf(this.shown.mode);
    if (this.shown.page !== page || from !== bufferOf(want)) this.swap(page, want);
    if (page && want !== "chat") this.arm(page.questions, from === "chat");
    this.shown = { page, mode: want };
  }

  /** Put what the input holds aside (chat draft or the shown page's answer) and load the buffer `want` uses. */
  private swap(page: QuestionPage | undefined, want: Mode): void {
    const from = bufferOf(this.shown.mode);
    if (from === "chat") this.chat = this.host.input;
    else if (from === "answer") this.shown.page!.questions.answer = this.host.input;
    const to = bufferOf(want);
    this.host.input = to === "chat" ? this.chat : to === "answer" ? page!.questions.answer : EMPTY;
  }

  /** Start the delay for a head not shown before, or when `again` (keys coming back from chat). */
  private arm(q: PageQuestions, again: boolean): void {
    const id = head(q)?.id;
    if (q.shownHead === id && !again) return;
    q.shownHead = id;
    q.readyAt = this.host.now() + this.delayMs;
  }

  // --- keys -------------------------------------------------------------------

  /**
   * Whether a key goes to the shown question; pure, so callers can ask
   * freely. Plain ↑↓ Enter Esc Tab, and typing on a row being picked (or
   * while the delay runs). Nothing in chat mode or in an agent view.
   */
  takes(k: Key): boolean {
    const page = this.host.page();
    const mode = this.want(page);
    if (mode === "chat") return false;
    if (typing(k)) return mode === "pick" || !this.ready(page!.questions);
    return plain(k) && TAKEN.has(k.name);
  }

  /** A key `takes` said yes to. */
  async handle(k: Key): Promise<void> {
    this.sync();
    const page = this.host.page();
    if (!page || bufferOf(this.shown.mode) === "chat") return;
    const named = this.keys[k.name];
    if (named) return named(page);
    if (!this.ready(page.questions)) return; // Enter, digits and typing wait out the delay
    if (k.name === "enter") return this.enter(page);
    return this.type(page, k.text ?? "");
  }

  /** Keys that work at once, delay or not. */
  private readonly keys: Record<string, (page: QuestionPage) => Promise<void> | void> = {
    tab: (page) => this.hide(page),
    escape: (page) => this.escape(page),
    up: (page) => this.move(page, -1),
    down: (page) => this.move(page, 1),
  };

  private ready(q: PageQuestions): boolean {
    return this.host.now() >= q.readyAt;
  }

  /** Typing on a row being picked: a digit picks that option; anything else starts the answer. */
  private type(page: QuestionPage, text: string): Promise<void> | void {
    const q = page.questions;
    const n = /^[1-9]$/.test(text) ? Number(text) : 0;
    if (n && n <= optionCount(q)) return this.close(page, head(q)!.options![n - 1]!);
    q.index = ownRow(q);
    this.sync();
    this.host.input = ed.insert(this.host.input, text);
  }

  /** Esc closes the panel, preserving both drafts; it never sends. */
  private escape(page: QuestionPage): void {
    this.hide(page);
  }

  /** ↑↓: between the answer's lines first, then through the rows. */
  private move(page: QuestionPage, dir: -1 | 1): void {
    if (this.shown.mode === "answer") {
      const moved = ed.vertical(this.host.input, this.host.width(), dir);
      if (moved) { this.host.input = moved; return; }
    }
    const q = page.questions;
    const rows = optionCount(q) + 2;
    q.index = (q.index + dir + rows) % rows;
    this.sync();
  }

  /** Enter: the selected option or skip, or the typed answer once it passes questions.clean (a known command runs instead). */
  private async enter(page: QuestionPage): Promise<void> {
    const q = page.questions;
    if (this.shown.mode === "pick") return this.close(page, q.index > ownRow(q) ? null : head(q)!.options![q.index]!);
    const text = this.host.input.text.trim();
    if (this.host.isCommand(text)) { this.host.input = EMPTY; return this.host.run(text); }
    let answer: string;
    try {
      answer = store.clean(text, store.limits.answer, "answer");
    } catch (err) {
      return this.host.say(dim(`not sent: ${message(err)}`), page);
    }
    if (!answer) return this.host.say(dim("type an answer, or choose skip"), page);
    return this.close(page, answer);
  }

  /** Answer (or, with null, skip) the shown question; one dim line goes to the page. Closed elsewhere: said, and a typed answer is kept. */
  private async close(page: QuestionPage, answer: string | null): Promise<void> {
    const q = page.questions;
    const h = head(q);
    if (!h || q.closing) return;
    q.closing = true;
    try {
      if (answer === null) await this.store.skip(page.project, h.id);
      else await this.store.answer(page.project, h.id, answer);
      q.mine.add(h.id);
      this.host.record(answeredLine(h.text, answer, h.default), page);
      this.reset(page);
    } catch (err) {
      if (!closedElsewhere(err)) return this.host.say(dim(`could not ${answer === null ? "skip" : "answer"}: ${message(err)}`), page);
      this.keepTyped(page, "already answered elsewhere; your answer was not sent");
    } finally {
      q.closing = false;
    }
    q.open = q.open.filter((x) => x.id !== h.id);
    if (!q.open.length) q.expanded = false;
    this.sync();
    this.host.draw();
  }

  /** Close until explicit reopening, even if new questions arrive. */
  private hide(page: QuestionPage): void {
    page.questions.expanded = false;
    page.questions.hidden = new Set(page.questions.open.map((x) => x.id));
    this.sync();
  }

  /** Explicit toggle; closing never answers and keeps both the chat and answer drafts. */
  async toggle(page = this.host.page()): Promise<void> {
    if (!page) return;
    if (page.questions.expanded) { this.hide(page); this.host.draw(); }
    else await this.command(page);
  }

  // --- /questions ---------------------------------------------------------------

  /** /questions: read and explicitly open the queue. */
  async command(page: QuestionPage | undefined): Promise<void> {
    if (!page) return;
    const q = page.questions;
    await q.polling;
    q.stamp = NaN;
    await this.pollPage(page);
    q.hidden = null;
    q.expanded = q.open.length > 0;
    if (!q.open.length) return this.host.say(dim("no open questions"), page);

    this.sync();
    this.host.draw();
  }
}
