import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { saveViewer, viewerHere } from "../core/viewer";
import { errorMessage, fail, loadConfig, ok, paths, type Result } from "../config";
import { contextWindow } from "../api/model";
import { answerConfirm, pendingConfirms, type Confirm } from "../core/confirm";
import { createConversation, listConversations, readConversation, saveConversation, type Conversation } from "../core/conversations";
import { daemonPid, readStatus, type DaemonStatus } from "../core/daemon/channel";
import { removeConversation } from "../core/lifecycle";
import { cancel, ensureDaemon, say, unsay } from "../core/daemon/client";
import { readLive } from "../core/daemon/live";
import { saveImage } from "../core/images";
import { COMMANDS, command as coreCommand, readViewClear, type CommandContext, type CoreCommand, type Run } from "../core/commands";
import { readInputHistory, recordInput, remember } from "../core/input-history";
import { pending } from "../core/inbox";
import { enabledNames } from "../core/plugins/enable";
import { availablePlugins } from "../core/plugins/loader";
import type { Attach, Fold, PickOptions, Row, Section, Tab, UiHost } from "../core/plugins/types";
import { bubblesFor, createBubble, ensureBubble, joinBubble, leaveBubbles, readBubble, setBubblePlugin } from "../core/bubbles";
import { runners, stopAgent, stopAgents } from "../core/runner/runtime";
import { listRuns, live } from "../core/runner/runs";
import { openTranscript, type Transcript } from "../core/transcript";
import { trustState } from "../core/trust";
import type { AgentEvent, Entry, Message, OpenSpan } from "../core/types";
import { bold, dim, editor, fit, keyLog, noColour, OPENABLE, pastel, readClipboardImage, readClipboardText, screens, TextInput, writeClipboardText, whaleRows, wordWrap, type InputClipboard, type Key, type Terminal } from "./components";
import { bubbleChoices, bubbleDetails, bubbleEntries, bubbleRows, bubbleTarget, type BubbleChoice } from "./bubbles";
import { archivedSection, isHeading, shelved } from "./archive";
import { isProblem, pluginDetails, pluginRows } from "./plugins-page";
import { archiveItems, restoreItems, shelfEntry, shelfKey } from "../core/shelf";
import { loadUis, type BoundUi } from "./plugins";
import { composerRows, items, pieces, tail, userItem, type ComposerBox } from "./view";
import { browsing, newer, older, onRecalled, sinceClear, type Browse, type Step } from "./history";
import { renderWork, type WorkTab } from "./work";
import { pickHint, pickKey, pickRows, pickStart, type PickState } from "./pick";
import { learnModel, type Choice } from "../core/settings";
import { Alerts, gistOf, type Notice } from "./alerts";

type Modal =
  | { kind: "confirm"; question: string; resolve: (yes: boolean) => void }
  | { kind: "input"; prompt: string; input: TextInput; resolve: (text: string | null) => void }
  | { kind: "pick"; state: PickState; resolve: (index: number | null) => void };

type Page = { tab: number; index: number; detailTop: number; rows: Row[]; details: Section[]; error: string | null; status: string; archiveOpen: boolean };

export type AppDeps = {
  terminal: Terminal;
  directory: string;
  now: () => number;
  ensureDaemon: (conversation: string) => Promise<Result<number>>;
  clipboard: () => Promise<Result<Uint8Array>>;
  copy: (text: string) => Promise<Result<null>>;
  pasteText: () => Promise<Result<string>>;
  openUrl: (url: string) => Promise<Result<null>>;
  open: (path: string) => Promise<void>;
  stopAgents: (conversation: string) => Promise<string[]>;
  exit: (code: number) => void;
};

const POLL_MS = 250;
const FRAME_MS = 40;
const NOTE_ROWS = 4;
const SIGN_IN_ROWS = 8;
const errorText = (line: string): string => noColour() ? line : `\x1b[${pastel.red}m${line}\x1b[0m`;
const SLOW_MS = 2000;
const PICK_ROWS = 8;
const HEADER_ROWS = 7;
const EDITING_CHORDS = new Set(["d", "e", "j", "k", "u", "w", "y", "z"]);

export class App {
  private current: { conversation: Conversation; transcript: Transcript } | null = null;
  private head: string | null = "unset";
  private cached: screens.ScreenItem[] = [];
  private lastText = "";
  private events: AgentEvent[] = [];
  private liveTurn = -1;
  private liveOffset = 0;
  private status: DaemonStatus | null = null;
  private busy = false;
  private waiting: OpenSpan | null = null;
  private readonly input: TextInput;
  private box: { top: number; box: ComposerBox } | null = null;
  private history: Browse = browsing([]);
  private cleared = new Map<string, string | null>();
  private viewClears = new Map<string, number>();
  private readonly openedAt = Date.now();
  private images: string[] = [];
  private queued: Message[] = [];
  private confirms: Confirm[] = [];
  private note = "";
  private noteError = false;
  private signing: { controller: AbortController; text: string } | null = null;
  private shownError: string | null = null;
  private open = new Set<string>();
  private modal: Modal | null = null;
  private page: Page | null = null;
  private uis: BoundUi[] = [];
  private folds = new Map<string, Fold>();
  private counts = "";
  private account = "";
  private bubbleName: string | null = null;
  private model = "";
  private learning = new Set<string>();
  private settings = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame: ReturnType<typeof setInterval> | null = null;
  private lastSlow = 0;
  private quitting = false;
  private noBubble = false;
  private activePlugins: string[] = [];
  private pluginsPage: { plugins: Awaited<ReturnType<typeof availablePlugins>>; enabled: string[] } | null = null;
  private openTabs: { id: string; name: string; busy: boolean }[] = [];
  private bubbles: Awaited<ReturnType<typeof bubbleEntries>> = { entries: [], loose: [] };
  private readonly alerts: Alerts;

  constructor(private readonly deps: AppDeps) {
    this.alerts = new Alerts(deps.terminal, process.env);
    this.input = new TextInput({ multiline: true, clipboard: this.clipboard(),
      onSubmit: () => this.submit("steer"),
      onVertical: (dir, atEdge) => this.recall(dir, atEdge),
      onNote: (text, error) => { this.flash(text, error); } });
  }

  private get composer(): editor.EditState { return this.input.state; }

  private clipboard(): InputClipboard {
    return { copy: text => this.copyText(text), paste: () => this.deps.pasteText() };
  }

  private async copyText(text: string): Promise<Result<null>> {
    const done = await this.deps.copy(text);
    if (done.ok) return done;
    return this.deps.terminal.copyOsc52?.(text) === true ? ok(null) : done;
  }

  private get conversation(): Conversation {
    if (this.current === null) throw new Error("the TUI used its conversation before start()");
    return this.current.conversation;
  }

  private get transcript(): Transcript {
    if (this.current === null) throw new Error("the TUI used its transcript before start()");
    return this.current.transcript;
  }

  conversationId(): string { return this.conversation.id; }

  private chat(): { id: string; name: string } { return { id: this.conversation.id, name: this.conversation.name }; }

  async refresh(): Promise<void> {
    this.lastSlow = Number.NEGATIVE_INFINITY;
    await this.poll();
  }

  private failed(error: unknown): void { this.flash(errorMessage(error), true); }

  async start(): Promise<void> {
    const here = (await listConversations()).filter(c => c.directory === this.deps.directory);
    const existing = here.at(0);
    this.openTabs = [...here].reverse().map(c => ({ id: c.id, name: c.name, busy: false }));
    await this.switchTo(existing ?? await createConversation(this.deps.directory, null));
    const fresh = existing === undefined;
    this.deps.terminal.onKey(key => { this.key(key).catch((error: unknown) => { this.failed(error); }); });
    this.deps.terminal.onResize(() => { this.head = "unset"; this.draw(); });
    this.deps.terminal.onAction(action => { this.action(action); });
    this.deps.terminal.open();
    this.timer = setInterval(() => { this.poll().catch((error: unknown) => { this.failed(error); }); }, POLL_MS);
    this.frame = setInterval(() => { if (this.animating()) this.draw(); }, FRAME_MS);
    await this.poll();
    if (fresh) this.offerBubble().catch((error: unknown) => { this.failed(error); });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.frame !== null) clearInterval(this.frame);
    this.alerts.leave();
    this.deps.terminal.close();
  }

  private async switchTo(conversation: Conversation): Promise<void> {
    await saveViewer(conversation.id, viewerHere(process.env, process.pid)).catch(() => undefined);
    this.lastSlow = Number.NEGATIVE_INFINITY;
    this.noBubble = conversation.noBubble;
    this.bubbleName = null;
    const known = this.openTabs.find(tab => tab.id === conversation.id);
    if (known === undefined) this.openTabs.push({ id: conversation.id, name: conversation.name, busy: false });
    else known.name = conversation.name;
    this.current = { conversation, transcript: openTranscript(paths.transcript(conversation.id, "orchestrator")) };
    this.head = "unset";
    this.events = [];
    this.liveTurn = -1;
    this.page = null;
    this.history = browsing(await readInputHistory(conversation.id).catch((): string[] => []));
    const loaded = await loadUis(conversation.id);
    this.uis = loaded.uis;
    this.folds = loaded.folds;
    this.activePlugins = loaded.active;
    if (loaded.problems.length > 0) this.flash(loaded.problems.join("; "));
    this.deps.terminal.setTitle?.(`orca2 · ${conversation.name}`);
    this.alerts.focus({ id: conversation.id, name: conversation.name });
    await this.startDaemon(conversation.id);
  }

  async poll(): Promise<void> {
    if (this.quitting) return;
    const id = this.conversation.id;
    this.transcript.refresh();
    if (this.transcript.head() !== this.head) {
      this.head = this.transcript.head();
      const all = sinceClear(this.transcript.all(), this.cleared.get(id) ?? null);
      const list = pieces(all);
      this.cached = items(list, { cols: this.deps.terminal.cols, open: this.open, folds: this.folds });
      const last = [...list].reverse().find(p => p.kind === "text");
      this.lastText = last?.kind === "text" ? last.text : "";
      this.alerts.notices(this.chat(), pluginNotices(all, this.activePlugins));
    }
    this.status = await readStatus(id);
    const turnError = this.status?.error ?? null;
    if (turnError !== null && turnError !== this.shownError) this.flash(`last turn failed: ${turnError}`, true);
    this.shownError = turnError;
    const pid = await daemonPid(id);
    this.busy = this.status !== null && this.status.state === "turn" && pid !== null;
    this.waiting = pid !== null && this.status !== null && this.status.state === "idle" ? this.status.phase : null;
    this.alerts.turn({ ...this.chat(), busy: this.busy, error: turnError, gist: gistOf(this.lastText) });
    if (this.busy && this.status !== null) {
      if (this.status.turns !== this.liveTurn) { this.liveTurn = this.status.turns; this.liveOffset = 0; this.events = []; }
      const read = await readLive(id, this.liveTurn, this.liveOffset);
      this.liveOffset = read.offset;
      this.events.push(...read.events);
      for (const event of read.events) if (event.kind === "notice") this.flash(event.text);
    } else this.events = [];
    this.queued = (await pending(id, "orchestrator")).map(item => item.message).filter(m => m.from === "user");
    this.confirms = await pendingConfirms(id);
    if (this.confirms.length > 0 && this.modal === null) this.answerConfirms().catch((error: unknown) => { this.failed(error); });
    if (this.deps.now() - this.lastSlow > SLOW_MS) {
      this.lastSlow = this.deps.now();
      await this.slow(pid);
    }
    this.draw();
  }

  private async slow(pid: number | null): Promise<void> {
    const id = this.conversation.id;
    if (pid === null && this.queued.length > 0) await this.deps.ensureDaemon(id).catch((error: unknown) => fail(errorMessage(error)));
    const runs = await listRuns(id);
    const running = runs.filter(r => r.agent !== "orchestrator" && live(r)).length;
    const bubbles = (await bubblesFor(this.conversation.directory)).length;
    const parts = [`${running} agent${running === 1 ? "" : "s"}`, `${bubbles} bubble${bubbles === 1 ? "" : "s"}`];
    for (const bound of this.uis) for (const count of bound.ui.counts) {
      const n = await count.count(bound.ctx).catch(() => null);
      if (count.id === "questions") this.alerts.questions(this.chat(), n);
      if (n !== null && n > 0) parts.push(count.label(n));
    }
    this.counts = parts.join(" │ ");
    await this.refreshHeader();
    for (const tab of this.openTabs) {
      if (tab.id === id) { tab.busy = this.busy; continue; }
      const status = await readStatus(tab.id);
      tab.busy = status !== null && status.state === "turn" && await daemonPid(tab.id) !== null;
      this.alerts.turn({ id: tab.id, name: tab.name, busy: tab.busy, error: status?.error ?? null, gist: "" });
    }
    if (this.page !== null) await this.loadPage();
  }

  private async refreshHeader(): Promise<void> {
    const id = this.conversation.id;
    const config = await loadConfig();
    const meta = await readConversation(id);
    const bubbleName = meta?.noBubble === true ? null : meta?.bubble == null ? null : (await readBubble(meta.bubble))?.name ?? meta.bubble;
    const viewClear = await readViewClear(id);
    if (this.conversation.id !== id) return;
    if (viewClear !== null && viewClear.at > (this.viewClears.get(id) ?? this.openedAt)) {
      this.viewClears.set(id, viewClear.at);
      this.cleared.set(id, viewClear.head);
      this.head = "unset";
    }
    if (meta !== null) {
      this.current = { conversation: meta, transcript: this.transcript };
      const tab = this.openTabs.find(t => t.id === id);
      if (tab !== undefined && tab.name !== meta.name) { tab.name = meta.name; this.deps.terminal.setTitle?.(`orca2 · ${meta.name}`); }
    }
    this.alerts.configure(config.notifications, config.notificationChannel);
    this.model = meta?.model ?? config.model;
    this.learn(this.model);
    this.settings = settingsLabel(meta);
    this.bubbleName = bubbleName;
    this.noBubble = meta?.noBubble === true;
    this.account = this.model.startsWith("claude") ? `anthropic:${config.account.length > 0 ? config.account : "default"}` : `openai:${config.openaiAccount.length > 0 ? config.openaiAccount : "default"}`;
  }

  private async answerConfirms(): Promise<void> {
    for (const confirm of this.confirms) {
      const yes = await this.ask({ kind: "confirm", question: `${confirm.agent} asks: ${confirm.question}` });
      await answerConfirm(this.conversation.id, confirm.id, yes);
    }
  }

  private ask(modal: { kind: "confirm"; question: string }): Promise<boolean>;
  private ask(modal: { kind: "input"; prompt: string; initial: string }): Promise<string | null>;
  private ask(modal: { kind: "pick"; title: string; options: string[]; opts: PickOptions | undefined }): Promise<number | null>;
  private ask(modal: { kind: "confirm"; question: string } | { kind: "input"; prompt: string; initial: string } | { kind: "pick"; title: string; options: string[]; opts: PickOptions | undefined }): Promise<boolean | string | number | null> {
    return new Promise(resolve => {
      if (modal.kind === "confirm") this.modal = { kind: "confirm", question: modal.question, resolve: yes => { this.modal = null; resolve(yes); this.draw(); } };
      else if (modal.kind === "input") {
        const done = (text: string | null): void => { this.modal = null; resolve(text); this.draw(); };
        const input = new TextInput({ multiline: false, clipboard: this.clipboard(), onSubmit: text => { done(text); }, onNote: (text, error) => { this.flash(text, error); } }, modal.initial);
        this.modal = { kind: "input", prompt: modal.prompt, input, resolve: done };
      }
      else this.modal = { kind: "pick", state: pickStart(modal.title, modal.options, modal.opts), resolve: index => { this.modal = null; resolve(index); this.draw(); } };
      this.draw();
    });
  }

  private host(bound: BoundUi): UiHost {
    return { ...bound.ctx, note: text => { this.flash(text); },
      confirm: question => this.ask({ kind: "confirm", question }),
      input: (prompt, initial) => this.ask({ kind: "input", prompt, initial }),
      pick: (title, options, opts) => this.ask({ kind: "pick", title, options, opts }),
      say: async text => { await say(this.conversation.id, text, [], "steer"); await this.startDaemon(this.conversation.id); },
      open: async path => { await this.deps.open(path); },
      attach: async plan => { await this.attach(plan); } };
  }

  private async startDaemon(conversation: string): Promise<boolean> {
    const started = await this.deps.ensureDaemon(conversation).catch((error: unknown) => fail(errorMessage(error)));
    if (!started.ok) this.flash(`daemon: ${started.error}`, true);
    return started.ok;
  }

  private animating(): boolean {
    return this.page === null && this.modal === null && (this.busy || (this.waiting !== null && this.waiting.kind !== "wait-inbox"));
  }

  private learn(model: string): void {
    if (this.learning.has(model)) return;
    this.learning.add(model);
    learnModel(model).then(learned => { if (learned) this.draw(); }, () => undefined);
  }

  private flash(text: string, error = false): void { this.note = text.replace(/\s+/g, " ").trim(); this.noteError = error; this.draw(); }

  private async key(key: Key): Promise<void> {
    keyLog(`app ${JSON.stringify(key)} modal=${this.modal?.kind ?? "none"} page=${String(this.page !== null)}`);
    if (key.ctrl === true && key.name === "c") { await this.kill(); return; }
    if (this.modal !== null) { await this.modalKey(this.modal, key); return; }
    if (this.page !== null) { await this.pageKey(key); return; }
    this.note = "";
    this.focusComposer();
    if (key.ctrl === true && await this.chord(key)) { this.draw(); return; }
    const handled = await this.input.key(key);
    keyLog(`composer ${handled ? "took" : "left"} ${JSON.stringify(key)} focused=${String(this.input.isFocused)} selection=${JSON.stringify(editor.selection(this.composer))}`);
    if (handled) { this.draw(); return; }
    switch (key.name) {
      case "tab": await this.submit(this.busy ? "follow" : "steer"); break;
      case "escape": if (this.signing !== null) this.signing.controller.abort(); else await this.takeBack(); break;
      case "pageup": case "wheelup": this.deps.terminal.scroll(key.name === "pageup" ? "page-up" : "up"); break;
      case "pagedown": case "wheeldown": this.deps.terminal.scroll(key.name === "pagedown" ? "page-down" : "down"); break;
      default: break;
    }
    this.draw();
  }

  private async chord(key: Key): Promise<boolean> {
    if (key.shift === true || key.alt === true || key.cmd === true) return false;
    if ((key.name === "a" && this.composer.text.length > 0) || EDITING_CHORDS.has(key.name)) return false;
    if (key.name === "n") { await this.newConversation(); return true; }
    if (key.name === "h" || key.name === "l") { await this.cycle(key.name === "h" ? -1 : 1); return true; }
    if (key.name === "v") { await this.pasteImage(); return true; }
    const tab = this.tabs().findIndex(t => t.chord === key.name);
    if (tab === -1) return false;
    await this.openPage(tab);
    return true;
  }

  private focusComposer(): void {
    if (this.modal?.kind === "input") { this.input.blur(); this.modal.input.focus(); return; }
    if (this.modal !== null || this.page !== null) this.input.blur(); else this.input.focus();
  }

  private recall(dir: -1 | 1, atEdge: boolean): boolean {
    const recalled = onRecalled(this.history, this.composer);
    if (!recalled && this.composer.text.length > 0) return false;
    if (!recalled && this.history.at !== null) this.history = browsing(this.history.entries);
    const step: Step | null = dir === -1 ? older(this.history, this.composer) : newer(this.history);
    if (step === null) return atEdge || recalled;
    this.history = step.browse;
    this.input.restore(step.state);
    return true;
  }

  private inputMouse(phase: "down" | "drag" | "up", row: number, col: number): void {
    const at = this.box;
    if (at === null || this.page !== null) return;
    const bodyRow = row - at.top - at.box.bodyTop;
    const inside = bodyRow >= 0 && bodyRow < at.box.bodyRows && col >= at.box.bodyLeft - 2;
    if (phase === "down" && !inside) return;
    const target = this.modal?.kind === "input" ? this.modal.input : this.input;
    if (phase === "down" && this.modal !== null && this.modal.kind !== "input") {
      if (this.modal.kind === "confirm") this.modal.resolve(false); else this.modal.resolve(null);
    }
    target.mouse(phase, bodyRow, col - at.box.bodyLeft, this.deps.now());
    this.draw();
  }

  private async remember(text: string): Promise<void> {
    const id = this.conversation.id;
    this.history = browsing(remember(this.history.entries, text));
    const saved = await recordInput(id, text).catch(() => null);
    if (saved !== null && this.conversation.id === id && this.history.at === null) this.history = browsing(saved);
  }

  private async modalKey(modal: Modal, key: Key): Promise<void> {
    if (modal.kind === "confirm") {
      if (key.name === "char" && (key.text === "y" || key.text === "Y")) modal.resolve(true);
      else if ((key.name === "char" && (key.text === "n" || key.text === "N")) || key.name === "escape") modal.resolve(false);
      return;
    }
    if (modal.kind === "pick") {
      const step = pickKey(modal.state, key);
      if (step.kind === "done") { modal.resolve(step.index); return; }
      if (step.kind === "move") modal.state = step.state;
      this.draw();
      return;
    }
    if (key.name === "escape") { modal.resolve(null); return; }
    modal.input.focus();
    await modal.input.key(key);
    if (this.modal === modal) this.draw();
  }

  private async submit(delivery: "steer" | "follow"): Promise<void> {
    const text = this.composer.text.trim();
    if (text.length === 0 && this.images.length === 0) return;
    this.input.setValue("");
    if (text.length > 0) await this.remember(text);
    else this.history = browsing(this.history.entries);
    if (text.startsWith("/")) { await this.command(text); return; }
    await say(this.conversation.id, text, this.images, delivery);
    this.images = [];
    await this.startDaemon(this.conversation.id);
    await this.poll();
  }

  private async takeBack(): Promise<void> {
    const last = this.queued.at(-1);
    if (last === undefined) return;
    const message = await unsay(this.conversation.id, last.id);
    if (message === null) return;
    this.input.setValue(message.text);
    this.history = browsing(this.history.entries);
    this.images = message.images;
    await this.poll();
  }

  private async pasteImage(): Promise<void> {
    try {
      const read = await this.deps.clipboard();
      if (!read.ok) { this.flash(`paste failed: ${read.error}`, true); return; }
      const saved = await saveImage(this.conversation.id, read.data);
      if (!saved.ok) { this.flash(`paste failed: ${saved.error}`, true); return; }
      this.images.push(saved.data);
      this.flash(`image attached (${this.images.length})`);
    } catch (error) { this.flash(`paste failed: ${errorMessage(error)}`, true); }
  }

  private async cycle(step: number): Promise<void> {
    const at = this.openTabs.findIndex(tab => tab.id === this.conversation.id);
    const next = this.openTabs[(at + step + this.openTabs.length) % this.openTabs.length];
    const conversation = next === undefined || next.id === this.conversation.id ? null : await readConversation(next.id);
    if (conversation !== null) await this.switchTo(conversation);
    this.draw();
  }

  private async closeTab(): Promise<void> {
    if (this.openTabs.length < 2) { this.flash("the last open chat stays open"); return; }
    const at = this.openTabs.findIndex(tab => tab.id === this.conversation.id);
    await this.cycle(at === this.openTabs.length - 1 ? -1 : 1);
    this.openTabs.splice(at, 1);
    this.draw();
  }

  private async newConversation(bubble: string | null = null): Promise<void> {
    const choice = bubble !== null ? { kind: "join" as const, id: bubble } : await this.chooseBubble("bubble for the new chat");
    if (choice === null) return;
    const created = await createConversation(this.deps.directory, null);
    const applied = await this.applyBubble(created.id, choice);
    if (!applied) return;
    this.page = null;
    await this.switchTo((await readConversation(created.id)) ?? created);
  }

  private async chooseBubble(title: string): Promise<BubbleChoice | null> {
    const { options, choices } = await bubbleChoices(this.deps.directory);
    const pick = await this.ask({ kind: "pick", title, options, opts: undefined });
    return pick === null ? null : choices[pick] ?? null;
  }

  private async applyBubble(conversation: string, choice: BubbleChoice): Promise<boolean> {
    if (choice.kind === "none") { const left = await leaveBubbles(conversation); if (!left.ok) this.flash(left.error, true); return left.ok; }
    if (choice.kind === "join") { const joined = await joinBubble(conversation, choice.id); if (!joined.ok) this.flash(joined.error, true); return joined.ok; }
    const name = await this.ask({ kind: "input", prompt: "name the new bubble: ", initial: basename(this.deps.directory) });
    if (name === null) return false;
    const made = await createBubble(conversation, name);
    if (!made.ok) this.flash(made.error, true); else this.flash(`new bubble ${made.data.name}`);
    return made.ok;
  }

  private async offerBubble(): Promise<void> {
    const choice = await this.chooseBubble("bubble for this chat");
    if (choice === null) return;
    const id = this.conversation.id;
    if (!await this.applyBubble(id, choice)) return;
    const conversation = await readConversation(id);
    if (conversation !== null && this.conversation.id === id) await this.switchTo(conversation);
    this.lastSlow = Number.NEGATIVE_INFINITY;
    await this.poll();
  }

  private async deleteChat(row: Row | undefined): Promise<void> {
    const target = bubbleTarget(row);
    if (target.kind !== "conversation") { this.flash("d deletes a chat: select one under its bubble"); return; }
    const meta = await readConversation(target.id);
    if (meta === null) return;
    const yes = await this.ask({ kind: "confirm", question: `delete chat ${meta.name}? its transcript, agents, worktrees and data go (the bubble stays)` });
    if (!yes) return;
    const notes: string[] = [];
    const removed = await removeConversation(meta.id, text => { notes.push(text.trim()); });
    if (!removed.ok) { this.flash(`delete: ${removed.error}`, true); return; }
    this.openTabs = this.openTabs.filter(tab => tab.id !== meta.id);
    if (meta.id === this.conversation.id) {
      const page = this.page;
      const next = this.openTabs[0];
      const other = next === undefined ? null : await readConversation(next.id);
      await this.switchTo(other ?? await createConversation(this.deps.directory, null));
      this.page = page;
    }
    this.flash(`deleted ${meta.name}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
  }

  private async command(text: string): Promise<void> {
    const [name = "", ...rest] = text.slice(1).split(/\s+/);
    const args = rest.join(" ");
    if (name === "quit" || name === "exit") { await this.quit(); return; }
    if (name === "kill") { await this.kill(); return; }
    if (name === "help") { this.flash(`Enter send · Shift+Enter new line · Tab queue after the work · Esc take back · Ctrl+C or /kill stop every agent and quit · /exit quit, agents keep running · /cancel stop the turn · Ctrl+A agents · Ctrl+B bubbles · Ctrl+P plugins · Ctrl+V image · Ctrl+N new · Ctrl+H/Ctrl+L switch chats · ↑/↓ earlier input · ⌥←/→ words · ⌘←/→ line · ⌘A select all · ⌘Z/⌘⇧Z undo/redo (Ctrl+Z/Ctrl+Y) · ⌘C/⌘X/⌘V copy/cut/paste · ${COMMANDS.map(c => `/${c.name}`).join(" ")}${this.commands().map(c => ` /${c.name}`).join("")}`); return; }
    if (name === "close") { await this.closeTab(); return; }
    if (name === "plugins") { await this.openPage(this.tabs().findIndex(t => t.id === "plugins")); return; }
    const core = coreCommand(name);
    if (core !== null && core.run !== null) { await this.runCore(core, core.run, rest.filter(a => a.length > 0)); return; }
    const own = this.uis.flatMap(bound => bound.ui.commands.map(command => ({ bound, command }))).find(c => c.command.name === name);
    if (own === undefined) { this.flash(`unknown command /${name}`); return; }
    try { await own.command.run(args, this.host(own.bound)); } catch (error) { this.flash(`/${name}: ${errorMessage(error)}`, true); }
  }

  private commandContext(signal: AbortSignal | null, write: (text: string) => void): CommandContext {
    const id = this.conversation.id;
    const fallback = this.conversation;
    return {
      conversation: async () => ok((await readConversation(id)) ?? fallback),
      directory: this.deps.directory,
      ensureDaemon: conversation => this.deps.ensureDaemon(conversation).catch((error: unknown) => fail(errorMessage(error))),
      stopAgents: conversation => this.deps.stopAgents(conversation),
      write,
      openBrowser: async url => { await this.deps.openUrl(url); },
      signal,
    };
  }

  private async runCore(c: CoreCommand, run: Run, given: string[]): Promise<void> {
    if (c.name === "login" && this.signing !== null) { this.flash("a sign-in is already waiting; esc cancels it", true); return; }
    const signing = c.name === "login" ? { controller: new AbortController(), text: "signing in…   esc cancels" } : null;
    const ctx = this.commandContext(signing === null ? null : signing.controller.signal, text => { if (signing !== null) { signing.text = `${text.trim()}   esc cancels`; this.draw(); } });
    let args = given;
    if (args.length === 0 && c.ask !== null) {
      if (c.ask.kind === "input") {
        const typed = await this.ask({ kind: "input", prompt: c.ask.prompt, initial: await c.ask.initial(ctx) });
        if (typed === null) return;
        args = [typed];
      } else {
        const listed = await c.ask.choices(ctx);
        if (!listed.ok) { this.flash(`/${c.name}: ${listed.error}`, true); return; }
        const picked = await this.choose(listed.data.title, listed.data.choices);
        if (picked === null) return;
        args = [picked];
      }
    }
    this.signing = signing;
    this.draw();
    const done = await run(args, ctx).catch((error: unknown) => fail(errorMessage(error)));
    if (signing !== null) this.signing = null;
    if (!done.ok) { this.flash(`/${c.name}: ${done.error}`, true); return; }
    await this.refreshHeader();
    this.flash(done.data);
  }

  private async choose<T>(title: string, choices: Choice<T>[]): Promise<T | null> {
    if (choices.length === 0) return null;
    const at = choices.findIndex(c => c.current);
    const picked = await this.ask({ kind: "pick", title, options: choices.map(c => c.detail.length > 0 ? `${c.label}  ${c.detail}` : c.label), opts: { current: at === -1 ? null : at } });
    return picked === null ? null : choices[picked]?.value ?? null;
  }

  private commands(): { name: string }[] {
    const seen = new Map<string, { name: string }>();
    for (const command of this.uis.flatMap(bound => bound.ui.commands)) if (!seen.has(command.name)) seen.set(command.name, command);
    return [...seen.values()];
  }

  private pluginPages(): Map<string, Tab[]> {
    return new Map(this.uis.map(bound => [bound.name, bound.ui.tabs]));
  }

  private openPluginPage(row: Row | undefined): void {
    const page = this.page;
    if (page === null || row === undefined || isProblem(row)) return;
    const at = this.tabs().findIndex(t => t.plugin !== null && t.plugin.name === row.id);
    if (at === -1) { page.status = this.activePlugins.includes(row.id) ? `${row.id} has no page; it adds tools or background work` : `${row.id} is off; t turns it on`; this.draw(); return; }
    this.openPage(at).catch((error: unknown) => { this.failed(error); });
  }

  private async togglePlugin(row: Row | undefined): Promise<void> {
    if (row === undefined || isProblem(row)) return;
    const name = row.id, on = this.activePlugins.includes(name) || (this.pluginsPage?.enabled.includes(name) ?? false);
    const ensured = this.conversation.bubble === null ? await ensureBubble(this.conversation.id) : null;
    if (ensured !== null && !ensured.ok) { this.flash(ensured.error, true); return; }
    const bubble = ensured === null ? this.conversation.bubble : ensured.data.id;
    if (bubble === null) return;
    const switched = await setBubblePlugin(bubble, name, on ? "off" : "on");
    if (!switched.ok) { this.flash(switched.error, true); return; }
    const index = this.page?.index ?? 0;
    await this.switchTo((await readConversation(this.conversation.id)) ?? this.conversation);
    await this.openPage(this.tabs().findIndex(t => t.id === "plugins"));
    if (this.page !== null) { this.page.index = index; this.page.status = `${name} ${on ? "off" : "on"} for this bubble (agents pick it up from their next turn)`; await this.loadPage(); }
    this.draw();
  }


  private async kill(): Promise<void> {
    if (this.quitting) return;
    this.flash("stopping every agent, then quitting…");
    const kill = coreCommand("kill")?.run ?? null;
    for (const tab of this.openTabs) {
      const meta = await readConversation(tab.id);
      if (kill === null || meta === null) continue;
      await kill([], { ...this.commandContext(null, () => undefined), conversation: async () => ok(meta) }).catch(() => undefined);
    }
    await this.quit();
  }

  private async quit(): Promise<void> {
    this.quitting = true;
    this.stop();
    this.deps.exit(0);
  }

  private action(action: screens.ScreenAction): void {
    if (action.kind === "toggle") {
      if (this.open.has(action.key)) this.open.delete(action.key); else this.open.add(action.key);
      this.head = "unset";
      this.poll().catch((error: unknown) => { this.failed(error); });
    } else if (action.kind === "open") {
      const tab = this.tabs().findIndex(t => t.id === action.tab);
      if (tab !== -1) this.openPage(tab).catch((error: unknown) => { this.failed(error); });
    } else if (action.kind === "input") {
      this.inputMouse(action.phase, action.row, action.col);
    } else if (action.kind === "copy") {
      const text = action.text;
      this.copyText(text).then(done => { this.flash(done.ok ? `copied ${text.length} character${text.length === 1 ? "" : "s"}` : `copy failed: ${done.error}`, !done.ok); },
        (error: unknown) => { this.failed(error); });
    } else {
      const url = action.url;
      if (!OPENABLE.test(url)) { this.flash(`not opened: ${url}`); return; }
      this.deps.openUrl(url).then(done => { this.flash(done.ok ? `opened ${url}` : `${done.error}: ${url}`, !done.ok); }, (error: unknown) => { this.failed(error); });
    }
  }

  private tabs(): (WorkTab & { chord: string | null; plugin: BoundUi | null })[] {
    return [{ id: "agents", title: "Agents", count: null, chord: "a", plugin: null },
      ...this.uis.flatMap(bound => bound.ui.tabs.map(tab => ({ id: tab.id, title: tab.title, count: null, chord: tab.chord, plugin: bound }))),
      { id: "bubbles", title: "Bubbles", count: null, chord: "b", plugin: null },
      { id: "plugins", title: "Plugins", count: null, chord: "p", plugin: null }];
  }

  private async openPage(tab: number): Promise<void> {
    this.page = { tab, index: 0, detailTop: 0, rows: [], details: [], error: null, status: "", archiveOpen: false };
    await this.loadPage();
    this.draw();
  }

  private async loadPage(): Promise<void> {
    const page = this.page;
    if (page === null) return;
    const tab = this.tabs()[page.tab];
    if (tab === undefined) return;
    try {
      if (tab.plugin === null && tab.id === "plugins") {
        const plugins = await availablePlugins(this.conversation.directory, await trustState(this.conversation.directory) === "trusted");
        this.pluginsPage = { plugins, enabled: await enabledNames(this.conversation.id) };
        page.rows = pluginRows(plugins.plugins, plugins.problems, this.pluginsPage.enabled, this.pluginPages());
      } else if (tab.plugin === null && tab.id === "bubbles") {
        this.bubbles = await bubbleEntries(this.conversation.directory);
        page.rows = bubbleRows(this.bubbles, this.conversation.id);
      } else if (tab.plugin === null) {
        const runs = await listRuns(this.conversation.id);
        page.rows = runs.map(r => ({ id: r.agent, name: r.agent, status: r.state === "running" && !live(r) ? "exited" : r.state, info: `${r.bundle} · ${r.lastTool ?? "-"} · ${r.startedAt.slice(11, 16)}`,
          tone: live(r) ? "good" : r.state === "failed" ? "bad" : "dim" }));
      } else {
        const def = tab.plugin.ui.tabs.find(t => t.id === tab.id);
        const rows = def === undefined ? [] : await def.rows(tab.plugin.ctx);
        page.rows = shelved(rows, await shelfEntry(this.conversation.id, shelfKey(tab.plugin.name, tab.id)), page.archiveOpen);
      }
      page.index = Math.min(page.index, Math.max(0, page.rows.length - 1));
      page.error = null;
      const row = page.rows[page.index];
      page.details = row === undefined ? [] : await this.details(tab, row);
    } catch (error) { page.error = errorMessage(error); page.rows = []; page.details = []; }
  }

  private async details(tab: ReturnType<App["tabs"]>[number], row: Row): Promise<Section[]> {
    if (tab.plugin !== null) {
      if (isHeading(row)) return [];
      const own = await tab.plugin.ui.tabs.find(t => t.id === tab.id)?.details(row, tab.plugin.ctx) ?? [];
      return [...archivedSection(await shelfEntry(this.conversation.id, shelfKey(tab.plugin.name, tab.id)), row), ...own];
    }
    if (tab.id === "bubbles") return bubbleDetails(this.bubbles, row);
    if (tab.id === "plugins") return this.pluginsPage === null ? [] : pluginDetails(this.pluginsPage.plugins.plugins, this.pluginsPage.plugins.problems, this.pluginsPage.enabled, this.pluginPages(), row);
    const run = (await listRuns(this.conversation.id)).find(r => r.agent === row.id);
    if (run === undefined) return [];
    const log = await readFile(run.log, "utf8").catch(() => "");
    return [{ title: "Run", lines: [`state ${run.state}${live(run) ? " (live)" : ""}`, `bundle ${run.bundle} · branch ${run.branch} · runner ${run.runner}`, `started ${run.startedAt}${run.endedAt === null ? "" : ` · ended ${run.endedAt}`}`, ...(run.error === null ? [] : [`error ${run.error}`]), `log ${run.log}`] },
      { title: "Log (last lines)", lines: log.split("\n").slice(-30) }];
  }

  private async pageKey(key: Key): Promise<void> {
    const page = this.page;
    if (page === null) return;
    const tabs = this.tabs();
    const tab = tabs[page.tab];
    const char = key.name === "char" ? key.text ?? "" : "";
    if (key.name === "escape" || char === "q") { this.page = null; this.draw(); return; }
    if (key.name === "down" || char === "j") page.index = Math.min(page.rows.length - 1, page.index + 1);
    else if (key.name === "up" || char === "k") page.index = Math.max(0, page.index - 1);
    else if (key.name === "tab" || key.name === "right" || char === "l") { page.tab = (page.tab + 1) % tabs.length; page.index = 0; }
    else if (key.name === "left" || char === "h") { page.tab = (page.tab - 1 + tabs.length) % tabs.length; page.index = 0; }
    else if (/^[1-9]$/.test(char) && Number(char) <= tabs.length) { page.tab = Number(char) - 1; page.index = 0; }
    else if (key.name === "pagedown") page.detailTop += 10;
    else if (key.name === "pageup") page.detailTop = Math.max(0, page.detailTop - 10);
    else if (char === "r") page.status = "";
    else if (tab?.id === "bubbles" && (key.name === "enter" || char === "n")) { await this.bubbleEnter(page.rows[page.index]); return; }
    else if (tab?.id === "bubbles" && char === "d") await this.deleteChat(page.rows[page.index]);
    else if (tab?.id === "plugins" && key.name === "enter") { this.openPluginPage(page.rows[page.index]); return; }
    else if (tab?.id === "plugins" && char === "t") { await this.togglePlugin(page.rows[page.index]); return; }
    else if (tab?.id === "agents" && key.name === "enter") { await this.attachAgent(page.rows[page.index]); }
    else if (tab?.id === "agents" && char === "s") { const row = page.rows[page.index]; if (row !== undefined) page.status = await stopAgent(this.conversation.id, row.id); }
    else if (tab?.plugin != null && (char === "a" || char === "A" || char === "u" || (key.name === "enter" && isHeading(page.rows[page.index])))) await this.shelve(tab.plugin, tab.id, page, char);
    else if (tab?.plugin != null) {
      const def = tab.plugin.ui.tabs.find(t => t.id === tab.id);
      const pressed = key.name === "enter" ? "enter" : char;
      const action = isHeading(page.rows[page.index]) ? undefined : def?.actions.find(a => a.key === pressed);
      if (action !== undefined) {
        try { await action.run(page.rows[page.index] ?? null, this.host(tab.plugin)); } catch (error) { page.status = `${action.label}: ${errorMessage(error)}`; }
      }
    }
    await this.loadPage();
    this.draw();
  }

  private async shelve(plugin: BoundUi, tabId: string, page: Page, char: string): Promise<void> {
    const key = shelfKey(plugin.name, tabId), id = this.conversation.id, now = new Date().toISOString();
    const row = page.rows[page.index];
    const entry = await shelfEntry(id, key);
    if (char === "") { page.archiveOpen = !page.archiveOpen; return; }
    if (char === "A") {
      const active = page.rows.filter(r => !isHeading(r) && entry.archived[r.id] === undefined);
      if (active.length === 0) { page.status = "nothing to archive"; return; }
      if (!await this.ask({ kind: "confirm", question: `archive all ${active.length} on this tab? (u restores)` })) return;
      await archiveItems(id, key, active.map(r => r.id), now);
      page.status = `archived ${active.length}`;
      return;
    }
    if (row === undefined || isHeading(row)) return;
    if (char === "a") {
      if (entry.archived[row.id] !== undefined) { page.status = `${row.name} is already archived; u restores it`; return; }
      await archiveItems(id, key, [row.id], now);
      page.status = `archived ${row.name}`;
      return;
    }
    if (entry.archived[row.id] === undefined) { page.status = `${row.name} is not archived`; return; }
    await restoreItems(id, key, [row.id], now);
    page.status = `restored ${row.name}`;
  }

  private async attach(plan: Attach): Promise<void> {
    if (plan.kind === "shown") { this.flash(plan.note); return; }
    const code = await this.deps.terminal.handOver(plan.argv);
    this.head = "unset";
    this.flash(code === 0 ? "back from the window" : `the window exited ${code}`);
  }

  private async attachAgent(row: Row | undefined): Promise<void> {
    if (row === undefined) return;
    const run = (await listRuns(this.conversation.id)).find(r => r.agent === row.id);
    if (run === undefined || !live(run)) { this.flash(`${row.id} is not running`); return; }
    const runner = (await runners(this.conversation.id)).find(r => r.name === run.runner);
    if (runner === undefined) { this.flash(`${row.id} runs in ${run.runner}, which is off in this bubble`, true); return; }
    const plan = await runner.attach(this.conversation.id, run.agent);
    if (!plan.ok) { this.flash(plan.error, true); return; }
    await this.attach(plan.data);
  }

  private async bubbleEnter(row: Row | undefined): Promise<void> {
    const target = bubbleTarget(row);
    if (target.kind === "bubble") { await this.newConversation(target.id); return; }
    if (target.kind !== "conversation") return;
    const conversation = await readConversation(target.id);
    if (conversation === null) return;
    this.page = null;
    if (conversation.id !== this.conversation.id) await this.switchTo(conversation);
    this.draw();
  }

  private draw(): void {
    const t = this.deps.terminal;
    this.focusComposer();
    if (this.page !== null) {
      const tabs = this.tabs();
      const tab = tabs[this.page.tab];
      const actions = tab?.id === "agents" ? "enter attach · s stop" : tab?.id === "bubbles" ? "enter open a chat, or start one in the bubble · d delete a chat" : tab?.id === "plugins" ? "enter open its page · t on/off for this bubble" : [...(tab?.plugin?.ui.tabs.find(x => x.id === tab.id)?.actions.map(a => `${a.key} ${a.label}`) ?? []), ...(tab?.plugin != null ? ["a archive", "A all", "u restore"] : [])].join(" · ");
      const status = this.modal !== null ? this.modalLine(this.modal) : this.note.length > 0 ? this.note : this.page.status.length > 0 ? this.page.status
        : dim(`j/k move · tab/h/l switch · ${actions}${actions.length > 0 ? " · " : ""}r reload · esc close`);
      t.show({ kind: "page", rows: renderWork({ tabs: tabs.map(x => ({ id: x.id, title: x.title, count: x.count })), active: this.page.tab, rows: this.page.rows, index: this.page.index,
        pick: this.modal?.kind === "pick" ? this.modal.state : null, details: this.page.details, detailTop: this.page.detailTop, status, error: this.page.error }, t.cols, t.rows), cursor: 0, col: 0 });
      return;
    }
    const cols = t.cols;
    const footer: string[] = [];
    if (this.signing !== null) for (const line of this.signing.text.split("\n").flatMap(row => wordWrap(row, cols)).slice(0, SIGN_IN_ROWS)) footer.push(dim(line));
    if (this.note.length > 0) for (const line of wordWrap(this.note, cols).slice(0, NOTE_ROWS)) footer.push(this.noteError ? errorText(line) : dim(line));
    const waiting = this.busy ? this.queued : [];
    for (const m of waiting.slice(-4)) footer.push(dim(fit(`queued (${m.delivery === "follow" ? "after the work" : "next"}): ${m.text.replace(/\s+/g, " ")}`, cols)));
    if (this.images.length > 0) footer.push(dim(`${this.images.length} image${this.images.length === 1 ? "" : "s"} attached`));
    let cursor: { row: number; col: number } | null = null;
    if (this.modal !== null && this.modal.kind !== "input") {
      footer.push(fit(this.modalLine(this.modal), cols));
      if (this.modal.kind === "pick") footer.push(...pickRows(this.modal.state, cols, PICK_ROWS + 1));
    }
    const composing = this.modal?.kind === "input" ? { prompt: this.modal.prompt, input: this.modal.input } : { prompt: "› ", input: this.input };
    const plugins = `${this.activePlugins.length} plugin${this.activePlugins.length === 1 ? "" : "s"} · Ctrl+P`;
    const box = composerRows(composing, this.counts, plugins, cols, Math.max(1, Math.floor(t.rows / 3)));
    this.box = { top: footer.length, box };
    cursor = box.cursor ? { row: footer.length + box.row, col: box.col } : null;
    footer.push(...box.rows);
    const fin = this.cached.length === 0 && this.queued.length === 0 && !this.busy ? null : { time: this.deps.now(), active: this.busy };
    const header: screens.ScreenHeader = { tabs: this.openTabs.map(tab => ({ label: tab.name, active: tab.id === this.conversation.id, busy: tab.id === this.conversation.id ? this.busy : tab.busy })), bubble: this.noBubble ? "no bubble" : this.bubbleName === null ? null : `bubble ${this.bubbleName}`,
      account: this.account.length > 0 ? `${this.account} · ${this.model}${this.settings}${contextLine(this.status?.contextTokens ?? null, this.model)}` : null, details: [this.conversation.directory], fin };
    const sent = this.busy ? [] : this.queued.map(m => userItem(m.text, `sent-${m.id}`, { cols, open: this.open }));
    t.show({ kind: "chat", header, items: [...this.cached, ...sent], tail: tail(this.events, this.lastText, cols, this.deps.now(), this.busy, this.waiting),
      updates: this.events.length, welcome: whaleRows(cols, t.rows - HEADER_ROWS - footer.length), footer, cursor });
  }

  private modalLine(modal: Modal): string {
    if (modal.kind === "confirm") return `${modal.question}  y yes · n/esc no`;
    if (modal.kind === "pick") return dim(pickHint(modal.state));
    return `${modal.prompt}${modal.input.value}`;
  }
}

const tokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export function settingsLabel(conversation: Conversation | null): string {
  if (conversation === null) return "";
  return `${conversation.effort !== null ? ` · ${conversation.effort}` : ""}${conversation.fast ? " · fast" : ""}`;
}

export function pluginNotices(entries: Entry[], plugins: string[]): Notice[] {
  const from = new Set(plugins);
  return entries.flatMap(entry => entry.type === "message" ? entry.inbox.filter(m => from.has(m.from)).map(m => ({ id: m.id, from: m.from, text: m.text })) : []);
}

export function contextLine(used: number | null, model: string): string {
  const window = contextWindow({}, model);
  return ` · ctx ${used === null ? "-" : tokens(used)}/${window.estimated ? "~" : ""}${tokens(window.limit)}`;
}

async function openUrl(url: string): Promise<Result<null>> {
  if (process.env.SSH_CONNECTION !== undefined) return fail("over ssh, open it yourself");
  const opener = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "linux" ? Bun.which("xdg-open") : null;
  if (opener === null) return fail("no browser opener (xdg-open) found");
  try {
    const exited = await Bun.spawn([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
    return exited === 0 ? ok(null) : fail(`${opener} exited ${exited}`);
  } catch (error) { return fail(errorMessage(error)); }
}

export async function startTui(directory: string): Promise<number> {
  const { openTuiTerminal } = await import("./otui");
  const opened = openTuiTerminal();
  if (!opened.ok) { process.stderr.write(`orca2: ${opened.error}\n`); return 1; }
  const terminal = opened.data;
  return new Promise<number>(resolve => {
    const app = new App({ terminal, directory, now: () => Date.now(),
      ensureDaemon: conversation => ensureDaemon(conversation, null),
      clipboard: async () => { const image = await readClipboardImage(); return image.ok ? ok(image.data.bytes) : image; },
      copy: text => writeClipboardText(text),
      pasteText: () => readClipboardText(),
      openUrl,
      stopAgents,
      open: async path => { await Bun.spawn(process.platform === "darwin" ? ["open", path] : ["xdg-open", path], { stdout: "ignore", stderr: "ignore" }).exited; },
      exit: code => { (terminal.released ?? Promise.resolve()).then(() => { resolve(code); }, () => { resolve(code); }); } });
    const abandon = (error: string): void => { app.stop(); process.stderr.write(`orca2: ${error}\n`); resolve(1); };
    terminal.launched.then(launched => { if (!launched.ok) abandon(launched.error); }, (error: unknown) => { abandon(errorMessage(error)); });
    app.start().catch((error: unknown) => { abandon(errorMessage(error)); });
  });
}
