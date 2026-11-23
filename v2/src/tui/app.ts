import { readFile } from "node:fs/promises";
import { errorMessage, fail, loadConfig, ok, paths, type Result } from "../config";
import { answerConfirm, pendingConfirms, type Confirm } from "../core/confirm";
import { createConversation, listConversations, readConversation, saveConversation, type Conversation } from "../core/conversations";
import { daemonPid, readStatus, type DaemonStatus } from "../core/daemon/channel";
import { removeConversation, renameConversation } from "../core/lifecycle";
import { cancel, compactNow, ensureDaemon, say, stopDaemon, unsay } from "../core/daemon/client";
import { readLive } from "../core/daemon/live";
import { saveImage } from "../core/images";
import { pending } from "../core/inbox";
import { enabledNames } from "../core/plugins/enable";
import { availablePlugins } from "../core/plugins/loader";
import type { Fold, Row, Section, Tab, UiHost } from "../core/plugins/types";
import { bubblesFor, ensureBubble, joinBubble, readBubble, setBubblePlugin } from "../core/bubbles";
import { stopAgent } from "../core/runner/runtime";
import { listRuns, live } from "../core/runner/runs";
import { openTranscript, type Transcript } from "../core/transcript";
import { setTrust, trustState } from "../core/trust";
import type { AgentEvent, Message, OpenSpan } from "../core/types";
import { dim, editor, fit, noColour, pastel, readClipboardImage, screens, whaleRows, wordWrap, type Key, type Terminal } from "./components";
import { bubbleChoices, bubbleDetails, bubbleEntries, bubbleRows, bubbleTarget } from "./bubbles";
import { archivedSection, isHeading, shelved } from "./archive";
import { isProblem, pluginDetails, pluginRows } from "./plugins-page";
import { archiveItems, restoreItems, shelfEntry, shelfKey } from "../core/shelf";
import { loadUis, type BoundUi } from "./plugins";
import { composerRows, items, pieces, tail } from "./view";
import { renderWork, type WorkTab } from "./work";

type Modal =
  | { kind: "confirm"; question: string; resolve: (yes: boolean) => void }
  | { kind: "input"; prompt: string; state: editor.EditState; resolve: (text: string | null) => void }
  | { kind: "pick"; title: string; options: string[]; index: number; resolve: (index: number | null) => void };

type Page = { tab: number; index: number; detailTop: number; rows: Row[]; details: Section[]; error: string | null; status: string; archiveOpen: boolean };

export type AppDeps = {
  terminal: Terminal;
  directory: string;
  now: () => number;
  ensureDaemon: (conversation: string) => Promise<Result<number>>;
  clipboard: () => Promise<Result<Uint8Array>>;
  exit: (code: number) => void;
};

const POLL_MS = 250;
const FRAME_MS = 40;
const NOTE_ROWS = 4;
const errorText = (line: string): string => noColour() ? line : `\x1b[${pastel.red}m${line}\x1b[0m`;
const SLOW_MS = 2000;
const PICK_ROWS = 8;
const HEADER_ROWS = 7;

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
  private composer: editor.EditState = { text: "", cursor: 0 };
  private images: string[] = [];
  private queued: Message[] = [];
  private confirms: Confirm[] = [];
  private note = "";
  private noteError = false;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame: ReturnType<typeof setInterval> | null = null;
  private lastSlow = 0;
  private quitting = false;
  private activePlugins: string[] = [];
  private pluginsPage: { plugins: Awaited<ReturnType<typeof availablePlugins>>; enabled: string[] } | null = null;
  private openTabs: { id: string; name: string; busy: boolean }[] = [];
  private bubbles: Awaited<ReturnType<typeof bubbleEntries>> = { entries: [], loose: [] };

  constructor(private readonly deps: AppDeps) {}

  private get conversation(): Conversation {
    if (this.current === null) throw new Error("the TUI used its conversation before start()");
    return this.current.conversation;
  }

  private get transcript(): Transcript {
    if (this.current === null) throw new Error("the TUI used its transcript before start()");
    return this.current.transcript;
  }

  conversationId(): string { return this.conversation.id; }

  async refresh(): Promise<void> {
    this.lastSlow = Number.NEGATIVE_INFINITY;
    await this.poll();
  }

  private failed(error: unknown): void { this.flash(errorMessage(error), true); }

  async start(): Promise<void> {
    const existing = (await listConversations()).find(c => c.directory === this.deps.directory);
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
    this.deps.terminal.close();
  }

  private async switchTo(conversation: Conversation): Promise<void> {
    const known = this.openTabs.find(tab => tab.id === conversation.id);
    if (known === undefined) this.openTabs.push({ id: conversation.id, name: conversation.name, busy: false });
    else known.name = conversation.name;
    this.current = { conversation, transcript: openTranscript(paths.transcript(conversation.id, "orchestrator")) };
    this.head = "unset";
    this.events = [];
    this.liveTurn = -1;
    this.page = null;
    const loaded = await loadUis(conversation.id);
    this.uis = loaded.uis;
    this.folds = loaded.folds;
    this.activePlugins = loaded.active;
    if (loaded.problems.length > 0) this.flash(loaded.problems.join("; "));
    this.deps.terminal.setTitle?.(`orca2 · ${conversation.name}`);
    await this.startDaemon(conversation.id);
  }

  async poll(): Promise<void> {
    if (this.quitting) return;
    const id = this.conversation.id;
    this.transcript.refresh();
    if (this.transcript.head() !== this.head) {
      this.head = this.transcript.head();
      const all = this.transcript.all();
      const list = pieces(all);
      this.cached = items(list, { cols: this.deps.terminal.cols, open: this.open, folds: this.folds });
      const last = [...list].reverse().find(p => p.kind === "text");
      this.lastText = last?.kind === "text" ? last.text : "";
    }
    this.status = await readStatus(id);
    const turnError = this.status?.error ?? null;
    if (turnError !== null && turnError !== this.shownError) this.flash(`last turn failed: ${turnError}`, true);
    this.shownError = turnError;
    const pid = await daemonPid(id);
    this.busy = this.status !== null && this.status.state === "turn" && pid !== null;
    this.waiting = pid !== null && this.status !== null && this.status.state === "idle" ? this.status.phase : null;
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
      if (n !== null && n > 0) parts.push(count.label(n));
    }
    this.counts = parts.join(" │ ");
    const config = await loadConfig();
    const meta = await readConversation(id);
    this.model = meta?.model ?? config.model;
    this.bubbleName = meta?.bubble == null ? null : (await readBubble(meta.bubble))?.name ?? meta.bubble;
    this.account = this.model.startsWith("claude") ? `anthropic:${config.account.length > 0 ? config.account : "default"}` : `openai:${config.openaiAccount.length > 0 ? config.openaiAccount : "default"}`;
    for (const tab of this.openTabs) {
      if (tab.id === id) { tab.busy = this.busy; continue; }
      const status = await readStatus(tab.id);
      tab.busy = status !== null && status.state === "turn" && await daemonPid(tab.id) !== null;
    }
    if (this.page !== null) await this.loadPage();
  }

  private async answerConfirms(): Promise<void> {
    for (const confirm of this.confirms) {
      const yes = await this.ask({ kind: "confirm", question: `${confirm.agent} asks: ${confirm.question}` });
      await answerConfirm(this.conversation.id, confirm.id, yes);
    }
  }

  private ask(modal: { kind: "confirm"; question: string }): Promise<boolean>;
  private ask(modal: { kind: "input"; prompt: string; initial: string }): Promise<string | null>;
  private ask(modal: { kind: "pick"; title: string; options: string[] }): Promise<number | null>;
  private ask(modal: { kind: "confirm"; question: string } | { kind: "input"; prompt: string; initial: string } | { kind: "pick"; title: string; options: string[] }): Promise<boolean | string | number | null> {
    return new Promise(resolve => {
      if (modal.kind === "confirm") this.modal = { kind: "confirm", question: modal.question, resolve: yes => { this.modal = null; resolve(yes); this.draw(); } };
      else if (modal.kind === "input") this.modal = { kind: "input", prompt: modal.prompt, state: { text: modal.initial, cursor: modal.initial.length }, resolve: text => { this.modal = null; resolve(text); this.draw(); } };
      else this.modal = { kind: "pick", title: modal.title, options: modal.options, index: 0, resolve: index => { this.modal = null; resolve(index); this.draw(); } };
      this.draw();
    });
  }

  private host(bound: BoundUi): UiHost {
    return { ...bound.ctx, note: text => { this.flash(text); },
      confirm: question => this.ask({ kind: "confirm", question }),
      input: (prompt, initial) => this.ask({ kind: "input", prompt, initial }),
      pick: (title, options) => this.ask({ kind: "pick", title, options }),
      say: async text => { await say(this.conversation.id, text, [], "steer"); await this.startDaemon(this.conversation.id); } };
  }

  private async startDaemon(conversation: string): Promise<boolean> {
    const started = await this.deps.ensureDaemon(conversation).catch((error: unknown) => fail(errorMessage(error)));
    if (!started.ok) this.flash(`daemon: ${started.error}`, true);
    return started.ok;
  }

  private animating(): boolean {
    return this.page === null && this.modal === null && (this.busy || (this.waiting !== null && this.waiting.kind !== "wait-inbox"));
  }

  private flash(text: string, error = false): void { this.note = text.replace(/\s+/g, " ").trim(); this.noteError = error; this.draw(); }

  private async key(key: Key): Promise<void> {
    if (this.modal !== null) { this.modalKey(this.modal, key); return; }
    if (this.page !== null) { await this.pageKey(key); return; }
    this.note = "";
    const id = this.conversation.id;
    if (key.ctrl === true) {
      if (key.name === "c") { if (this.busy) { await cancel(id); this.flash("cancelling…"); } else if (this.composer.text.length > 0) this.composer = { text: "", cursor: 0 }; else this.flash("Ctrl+D quits"); }
      else if (key.name === "d" && this.composer.text.length === 0) { await this.quit(); return; }
      else if (key.name === "a") await this.openPage(0);
      else if (key.name === "n") await this.newConversation();
      else if (key.name === "v") await this.pasteImage();
      else if (key.name === "j") this.composer = editor.newline(this.composer);
      else if (key.name === "u") this.composer = editor.killToStart(this.composer);
      else if (key.name === "k") this.composer = editor.killToEnd(this.composer);
      else if (key.name === "w") this.composer = editor.deleteWordBack(this.composer);
      else {
        const tab = this.tabs().findIndex(t => t.chord === key.name);
        if (tab !== -1) await this.openPage(tab);
      }
      this.draw();
      return;
    }
    if (key.alt === true && (key.name === "left" || key.name === "right")) { await this.cycle(key.name === "left" ? -1 : 1); return; }
    switch (key.name) {
      case "enter": if (key.shift === true || key.alt === true) this.composer = editor.newline(this.composer); else await this.submit("steer"); break;
      case "tab": await this.submit(this.busy ? "follow" : "steer"); break;
      case "escape": await this.takeBack(); break;
      case "pageup": case "wheelup": this.deps.terminal.scroll(key.name === "pageup" ? "page-up" : "up"); break;
      case "pagedown": case "wheeldown": this.deps.terminal.scroll(key.name === "pagedown" ? "page-down" : "down"); break;
      default: this.composer = edit(this.composer, key);
    }
    this.draw();
  }

  private modalKey(modal: Modal, key: Key): void {
    if (modal.kind === "confirm") {
      if (key.name === "char" && (key.text === "y" || key.text === "Y")) modal.resolve(true);
      else if ((key.name === "char" && (key.text === "n" || key.text === "N")) || key.name === "escape") modal.resolve(false);
      return;
    }
    if (modal.kind === "pick") {
      if (key.name === "escape") modal.resolve(null);
      else if (key.name === "enter") modal.resolve(modal.index);
      else if (key.name === "up" || (key.name === "char" && key.text === "k")) modal.index = Math.max(0, modal.index - 1);
      else if (key.name === "down" || (key.name === "char" && key.text === "j")) modal.index = Math.min(modal.options.length - 1, modal.index + 1);
      this.draw();
      return;
    }
    if (key.name === "escape") modal.resolve(null);
    else if (key.name === "enter") modal.resolve(modal.state.text);
    else modal.state = edit(modal.state, key);
    this.draw();
  }

  private async submit(delivery: "steer" | "follow"): Promise<void> {
    const text = this.composer.text.trim();
    if (text.length === 0 && this.images.length === 0) return;
    this.composer = { text: "", cursor: 0 };
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
    this.composer = { text: message.text, cursor: message.text.length };
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

  private async rename(args: string): Promise<void> {
    const requested = args.trim().length > 0 ? args : await this.ask({ kind: "input", prompt: "rename to ", initial: this.conversation.name });
    if (requested === null) return;
    const renamed = await renameConversation(this.conversation.id, requested);
    if (!renamed.ok) { this.flash(`/rename: ${renamed.error}`, true); return; }
    const { conversation, bubble } = renamed.data;
    this.current = { conversation, transcript: this.transcript };
    const tab = this.openTabs.find(t => t.id === conversation.id);
    if (tab !== undefined) tab.name = conversation.name;
    if (bubble !== null) this.bubbleName = bubble;
    this.deps.terminal.setTitle?.(`orca2 · ${conversation.name}`);
    this.flash(`renamed to ${conversation.name}${bubble === null ? "" : " (its bubble too)"}`);
  }

  private async closeTab(): Promise<void> {
    if (this.openTabs.length < 2) { this.flash("the last open chat stays open"); return; }
    const at = this.openTabs.findIndex(tab => tab.id === this.conversation.id);
    await this.cycle(at === this.openTabs.length - 1 ? -1 : 1);
    this.openTabs.splice(at, 1);
    this.draw();
  }

  private async newConversation(bubble: string | null = null): Promise<void> {
    let chosen = bubble;
    if (chosen === null) {
      const choices = await bubbleChoices(this.deps.directory);
      if (choices.ids.length > 1) {
        const pick = await this.ask({ kind: "pick", title: "bubble for the new chat", options: choices.options });
        if (pick === null) return;
        chosen = choices.ids[pick] ?? null;
      }
    }
    const created = await createConversation(this.deps.directory, null);
    if (chosen !== null) {
      const joined = await joinBubble(created.id, chosen);
      if (!joined.ok) { this.flash(joined.error, true); return; }
    }
    this.page = null;
    await this.switchTo((await readConversation(created.id)) ?? created);
  }

  private async offerBubble(): Promise<void> {
    const choices = await bubbleChoices(this.deps.directory);
    if (choices.ids.length < 2) return;
    const pick = await this.ask({ kind: "pick", title: "bubble for this chat", options: choices.options });
    const chosen = pick === null ? null : choices.ids[pick] ?? null;
    if (chosen === null) return;
    const id = this.conversation.id;
    const joined = await joinBubble(id, chosen);
    if (!joined.ok) { this.flash(joined.error, true); return; }
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
    const id = this.conversation.id;
    if (name === "quit" || name === "exit") { await this.quit(); return; }
    if (name === "help") { this.flash(`Enter send · Shift+Enter new line · Tab queue after the work · Esc take back · Ctrl+C stop · Ctrl+A agents · Ctrl+B bubbles · Ctrl+P plugins · Ctrl+V image · Ctrl+N new · Alt+←/→ switch chats · /rename · /close · /compact /model /plugins /trust /stop /quit${this.commands().map(c => ` /${c.name}`).join("")}`); return; }
    if (name === "compact") { await compactNow(id); if (await this.startDaemon(id)) this.flash("compacting…"); return; }
    if (name === "rename") { await this.rename(args); return; }
    if (name === "close") { await this.closeTab(); return; }
    if (name === "stop") { await stopDaemon(id); this.flash("daemon stopped"); return; }
    if (name === "trust") { await setTrust(this.deps.directory, true); this.flash("folder trusted again (restart agents to load its instructions)"); return; }
    if (name === "model") {
      const model = args.trim().length > 0 ? args.trim() : await this.ask({ kind: "input", prompt: "model ", initial: this.model });
      if (model === null || model.length === 0) return;
      await saveConversation({ ...this.conversation, model });
      this.current = { conversation: { ...this.conversation, model }, transcript: this.transcript };
      this.flash(`model ${model} from the next request`);
      return;
    }
    if (name === "plugins") { await this.openPage(this.tabs().findIndex(t => t.id === "plugins")); return; }
    const own = this.uis.flatMap(bound => bound.ui.commands.map(command => ({ bound, command }))).find(c => c.command.name === name);
    if (own === undefined) { this.flash(`unknown command /${name}`); return; }
    try { await own.command.run(args, this.host(own.bound)); } catch (error) { this.flash(`/${name}: ${errorMessage(error)}`, true); }
  }

  private commands(): { name: string }[] { return this.uis.flatMap(bound => bound.ui.commands); }

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
    if (this.page !== null) {
      const tabs = this.tabs();
      const tab = tabs[this.page.tab];
      const actions = tab?.id === "agents" ? "s stop" : tab?.id === "bubbles" ? "enter open a chat, or start one in the bubble · d delete a chat" : tab?.id === "plugins" ? "enter open its page · t on/off for this bubble" : [...(tab?.plugin?.ui.tabs.find(x => x.id === tab.id)?.actions.map(a => `${a.key} ${a.label}`) ?? []), ...(tab?.plugin != null ? ["a archive", "A all", "u restore"] : [])].join(" · ");
      const status = this.modal !== null ? this.modalLine(this.modal) : this.note.length > 0 ? this.note : this.page.status.length > 0 ? this.page.status
        : dim(`j/k move · tab/h/l switch · ${actions}${actions.length > 0 ? " · " : ""}r reload · esc close`);
      t.show({ kind: "page", rows: renderWork({ tabs: tabs.map(x => ({ id: x.id, title: x.title, count: x.count })), active: this.page.tab, rows: this.page.rows, index: this.page.index,
        details: this.page.details, detailTop: this.page.detailTop, status, error: this.page.error }, t.cols, t.rows), cursor: 0, col: 0 });
      return;
    }
    const cols = t.cols;
    const footer: string[] = [];
    if (this.note.length > 0) for (const line of wordWrap(this.note, cols).slice(0, NOTE_ROWS)) footer.push(this.noteError ? errorText(line) : dim(line));
    const waiting = this.busy ? this.queued : [];
    for (const m of waiting.slice(-4)) footer.push(dim(fit(`queued (${m.delivery === "follow" ? "after the work" : "next"}): ${m.text.replace(/\s+/g, " ")}`, cols)));
    if (this.images.length > 0) footer.push(dim(`${this.images.length} image${this.images.length === 1 ? "" : "s"} attached`));
    let cursor: { row: number; col: number } | null = null;
    if (this.modal !== null && this.modal.kind !== "input") {
      footer.push(fit(this.modalLine(this.modal), cols));
      if (this.modal.kind === "pick") {
        const pick = this.modal;
        const start = Math.max(0, Math.min(pick.index - Math.floor(PICK_ROWS / 2), pick.options.length - PICK_ROWS));
        pick.options.slice(start, start + PICK_ROWS).forEach((option, i) => { footer.push(fit(`${start + i === pick.index ? "❯" : " "} ${option}`, cols)); });
        if (pick.options.length > PICK_ROWS) footer.push(dim(`${pick.index + 1} of ${pick.options.length}`));
      }
    }
    const composing = this.modal?.kind === "input" ? { prompt: this.modal.prompt, state: this.modal.state } : { prompt: "› ", state: this.composer };
    const plugins = `${this.activePlugins.length} plugin${this.activePlugins.length === 1 ? "" : "s"} · Ctrl+P`;
    const box = composerRows(composing, this.counts, plugins, cols, Math.max(1, Math.floor(t.rows / 3)));
    cursor = { row: footer.length + box.row, col: box.col };
    footer.push(...box.rows);
    const fin = this.cached.length === 0 && this.queued.length === 0 && !this.busy ? null : { time: this.deps.now(), active: this.busy };
    const header: screens.ScreenHeader = { tabs: this.openTabs.map(tab => ({ label: tab.name, active: tab.id === this.conversation.id, busy: tab.id === this.conversation.id ? this.busy : tab.busy })), bubble: this.bubbleName === null ? null : `bubble ${this.bubbleName}`,
      account: this.account.length > 0 ? `${this.account} · ${this.model}` : null, details: [this.conversation.directory], fin };
    const sent = this.busy ? [] : this.queued.flatMap(m => items([{ kind: "user", text: m.text }], { cols, open: this.open, folds: this.folds }).map(item => ({ ...item, key: `sent-${m.id}` })));
    t.show({ kind: "chat", header, items: [...this.cached, ...sent], tail: tail(this.events, this.lastText, cols, this.deps.now(), this.busy, this.waiting),
      welcome: whaleRows(cols, t.rows - HEADER_ROWS - footer.length), footer, cursor });
  }

  private modalLine(modal: Modal): string {
    if (modal.kind === "confirm") return `${modal.question}  y yes · n/esc no`;
    if (modal.kind === "pick") return `${modal.title}  ↑↓ choose · enter · esc`;
    return `${modal.prompt}${modal.state.text}`;
  }
}

function edit(state: editor.EditState, key: Key): editor.EditState {
  switch (key.name) {
    case "char": case "paste": return editor.insert(state, key.text ?? "");
    case "backspace": return key.alt === true ? editor.deleteWordBack(state) : editor.backspace(state);
    case "delete": return editor.deleteForward(state);
    case "left": return key.alt === true ? editor.wordLeft(state) : editor.left(state);
    case "right": return key.alt === true ? editor.wordRight(state) : editor.right(state);
    case "home": return editor.home(state);
    case "end": return editor.end(state);
    default: return state;
  }
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
      exit: code => { (terminal.released ?? Promise.resolve()).then(() => { resolve(code); }, () => { resolve(code); }); } });
    const abandon = (error: string): void => { app.stop(); process.stderr.write(`orca2: ${error}\n`); resolve(1); };
    terminal.launched.then(launched => { if (!launched.ok) abandon(launched.error); }, (error: unknown) => { abandon(errorMessage(error)); });
    app.start().catch((error: unknown) => { abandon(errorMessage(error)); });
  });
}
