// The orchestrator's questions in the TUI, like Codex's pending questions:
// the oldest open question of the active page sits in the live region above
// the status line (render.ts questionRows) until it is answered, skipped
// (Esc, the orchestrator uses its default) or put off (Tab, until a new one
// arrives or /questions). The backend is ../questions.ts.
//
// The input is shared: while a question is shown the chat draft is put
// aside, and the input is the question's answer ("answer>" on the "type your
// own answer" row, or for a question without options; empty on an option
// row). It comes back when the question goes, is put off, or the page
// changes; a half-typed answer is kept with its page the same way.

import { stat } from "node:fs/promises";
import { paths } from "../config";
import * as store from "../questions";
import type { EditState } from "./editor";
import type { Key } from "./keys";
import type { Line } from "./lines";
import { dim, type QuestionView } from "./render";
import { answeredLine, questionReply } from "./restore";

type Question = store.Question;

/** What the TUI reads and closes questions with; tests stub it. `stamp` changes whenever the questions dir does. */
export interface QuestionStore {
  stamp(project: string): Promise<number>;
  list(project: string): Promise<Question[]>;
  answer(project: string, id: string, text: string): Promise<unknown>;
  skip(project: string, id: string): Promise<unknown>;
}

export const fileStore: QuestionStore = {
  stamp: (project) => stat(paths.questions(project)).then((s) => s.mtimeMs, () => -1),
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
  /** The questions dir's stamp at the last read, and when that read started (wall clock). */
  stamp: number;
  readAt: number;
  /** The read in flight, if any; polls never overlap. */
  polling: Promise<void> | null;
  /** Tab: the ids open when the queue was put off; it shows again once another one is open. */
  hidden: Set<string> | null;
  /** The selected row of the shown question; options.length is "type your own answer". */
  index: number;
  /** The answer typed so far, while the input shows something else. */
  answer: EditState;
  /** An answer or skip in flight. */
  closing: boolean;
  /** Ids answered or skipped here: already on screen when the orchestrator reads them, and never shown again by a stale read. */
  mine: Set<string>;
}

export interface QuestionPage { project: string; name: string; questions: PageQuestions }

/** What the controller needs from the app. */
export interface QuestionHost {
  page(): QuestionPage | undefined;
  input: EditState;
  /** A note: on screen now, in an agent view too. */
  say(line: string, page: QuestionPage): void;
  /** A line of the page's own history (an answered question), as the orchestrator's transcript will show it. */
  record(line: string, page: QuestionPage): void;
  draw(): void;
}

const EMPTY: EditState = { text: "", cursor: 0 };

export const pageQuestions = (): PageQuestions => ({ open: [], stamp: NaN, readAt: 0, polling: null, hidden: null, index: 0, answer: EMPTY, closing: false, mine: new Set() });

type Mode = "chat" | "options" | "answer";

const head = (q: PageQuestions) => q.open[0];
const visible = (q: PageQuestions) => q.open.length > 0 && (!q.hidden || q.open.some((x) => !q.hidden!.has(x.id)));
const optionCount = (q: PageQuestions) => head(q)?.options?.length ?? 0;
const mode = (q: PageQuestions): Mode => (!visible(q) ? "chat" : q.index >= optionCount(q) ? "answer" : "options");
const plural = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`;

/** Plain keys only: Ctrl, Alt and Shift chords never pick, skip or put off a question. */
const plain = (k: Key) => !k.ctrl && !k.alt && !k.shift;
/** Typed text (a printable run or a paste), as the input would insert it. */
const typing = (k: Key) => (k.name === "char" || k.name === "paste") && !k.ctrl && !k.alt;
/** The keys a shown question takes (↑↓ only when it has options). */
const TAKEN = new Set(["up", "down", "enter", "escape", "tab"]);

export class Questions {
  /** Which page's which buffer the input holds now. */
  private shown: { page: QuestionPage | undefined; mode: Mode } = { page: undefined, mode: "chat" };
  /** The chat draft, while the input holds a question's answer. */
  private chat: EditState = EMPTY;

  constructor(private readonly host: QuestionHost, private readonly store: QuestionStore = fileStore) {}

  // --- polling ----------------------------------------------------------------

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

  /** New open questions: a new one ends a Tab; a new oldest one starts at its first option. */
  private update(page: QuestionPage, open: Question[]): void {
    const q = page.questions;
    const before = head(q)?.id;
    q.open = open;
    if (q.hidden && open.some((x) => !q.hidden!.has(x.id))) q.hidden = null;
    if (head(q)?.id !== before) this.reset(page);
    this.host.draw();
  }

  /** A new question at the head: first row, no answer typed. */
  private reset(page: QuestionPage): void {
    page.questions.index = 0;
    page.questions.answer = EMPTY;
    if (this.shown.page === page && this.shown.mode === "answer") this.host.input = EMPTY;
  }

  // --- what shows -------------------------------------------------------------

  /** The active page's shown question, for the frame. */
  view(): QuestionView | null {
    const q = this.host.page()?.questions;
    const h = q && visible(q) ? head(q) : undefined;
    if (!q || !h) return null;
    return { text: h.text, options: h.options ?? [], index: q.index, ...(h.default ? { default: h.default } : {}), count: q.open.length };
  }

  /** Whether the input is the shown question's answer ("answer>"). */
  answering(): boolean {
    const page = this.host.page();
    return !!page && mode(page.questions) === "answer";
  }

  /** "N questions" for the active page, "<name>: N questions" for each other page with open ones. */
  status(active: QuestionPage, pages: QuestionPage[]): string[] {
    const n = active.questions.open.length;
    const others = pages.filter((p) => p !== active && p.questions.open.length > 0).map((p) => `${p.name}: ${plural(p.questions.open.length)}`);
    return [...(n ? [plural(n)] : []), ...others];
  }

  /** A "user" message the orchestrator read: a question's answer as its dim line, or nothing when it was answered here (already shown). Null for anything else. */
  inboxLines(page: QuestionPage, text: string): Line[] | null {
    const reply = questionReply(text);
    if (!reply) return null;
    return page.questions.mine.has(reply.id) ? [] : [reply.line];
  }

  /** Put the right buffer in the input: the chat draft, or the active page's answer. Call before reading or editing the input. */
  sync(): void {
    const page = this.host.page();
    const want: Mode = page ? mode(page.questions) : "chat";
    if (this.shown.page === page && this.shown.mode === want) return;
    if (this.shown.mode === "chat") this.chat = this.host.input;
    else if (this.shown.mode === "answer" && this.shown.page) this.shown.page.questions.answer = this.host.input;
    this.host.input = want === "chat" ? this.chat : want === "answer" ? page!.questions.answer : EMPTY;
    this.shown = { page, mode: want };
  }

  // --- keys -------------------------------------------------------------------

  /**
   * Whether a key goes to the shown question: plain ↑↓ (with options), Enter,
   * Esc and Tab. Typing on an option row moves to "type your own answer" and
   * is left to the input. Synchronous, so keys left to the input are edited in order.
   */
  takes(k: Key): boolean {
    this.sync();
    const page = this.host.page();
    if (!page || mode(page.questions) === "chat") return false;
    if (typing(k)) return this.typed(page);
    if (!plain(k) || !TAKEN.has(k.name)) return false;
    return optionCount(page.questions) > 0 || (k.name !== "up" && k.name !== "down");
  }

  /** A key `takes` said yes to. */
  async handle(k: Key): Promise<void> {
    const page = this.host.page()!;
    if (k.name === "up" || k.name === "down") return this.move(page, k.name === "up" ? -1 : 1);
    if (k.name === "enter") return this.enter(page);
    if (k.name === "escape") return this.close(page, null);
    this.hide(page);
  }

  private typed(page: QuestionPage): false {
    page.questions.index = optionCount(page.questions);
    this.sync();
    return false;
  }

  /** ↑↓ through the options and "type your own answer". */
  private move(page: QuestionPage, dir: -1 | 1): void {
    const q = page.questions;
    const rows = optionCount(q) + 1;
    q.index = (q.index + dir + rows) % rows;
    this.sync();
  }

  /** Enter: the selected option, or the typed answer once it passes questions.clean. */
  private async enter(page: QuestionPage): Promise<void> {
    const q = page.questions;
    const h = head(q)!;
    if (mode(q) === "options") return this.close(page, h.options![q.index]!);
    let answer: string;
    try {
      answer = store.clean(this.host.input.text, store.limits.answer, "answer");
    } catch (err) {
      return this.host.say(dim(`not sent: ${err instanceof Error ? err.message : String(err)}`), page);
    }
    if (!answer) return this.host.say(dim("type an answer, or Esc to skip"), page);
    return this.close(page, answer);
  }

  /** Answer (or, with null, skip) the shown question; one dim line goes to the scrollback. Closed elsewhere: dropped quietly. */
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already|no question/.test(msg)) return this.host.say(dim(`could not ${answer === null ? "skip" : "answer"}: ${msg}`), page);
    } finally {
      q.closing = false;
    }
    q.open = q.open.filter((x) => x.id !== h.id);
    this.reset(page);
    this.sync();
    this.host.draw();
  }

  /** Tab: put the queue off until a new question arrives or /questions. */
  private hide(page: QuestionPage): void {
    page.questions.hidden = new Set(page.questions.open.map((x) => x.id));
    this.sync();
  }

  // --- /questions ---------------------------------------------------------------

  /** /questions: read the queue now, show it again, and list it when there are several. */
  async command(page: QuestionPage | undefined): Promise<void> {
    if (!page) return;
    const q = page.questions;
    await q.polling;
    q.stamp = NaN;
    await this.pollPage(page);
    q.hidden = null;
    if (!q.open.length) return this.host.say(dim("no open questions"), page);
    if (q.open.length > 1) q.open.forEach((x, i) => this.host.say(dim(`${i + 1}. ${x.text}${x.default ? ` (default: ${x.default})` : ""}`), page));
    this.sync();
    this.host.draw();
  }
}
