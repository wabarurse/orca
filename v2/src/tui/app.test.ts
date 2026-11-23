import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig, saveConfig } from "../config";
import { askUser, pendingConfirms } from "../core/confirm";
import { writeStatus } from "../core/daemon/channel";
import { ensureBubble, readBubble, setBubbleDirectory } from "../core/bubbles";
import { createConversation, readConversation } from "../core/conversations";
import { pending } from "../core/inbox";
import { registerBuiltins } from "../core/plugins";
import { setTrust } from "../core/trust";
import { BUILTINS } from "../plugins";
import { tempHome } from "../test/home";
import { App } from "./app";
import type { Key, screens, Terminal } from "./components";

const home = tempHome("tui");

function fakeTerminal() {
  const keys: ((key: Key) => void)[] = [];
  const acts: ((action: screens.ScreenAction) => void)[] = [];
  const handed: string[][] = [];
  const state: { screen: screens.Screen | null } = { screen: null };
  const terminal: Terminal = { cols: 100, rows: 30, write() {}, onKey: cb => { keys.push(cb); }, onResize() {}, open() {}, close() {}, eraseOnExit() {},
    show: screen => { state.screen = screen; }, scroll() {}, onAction: cb => { acts.push(cb); }, selection: () => "", handOver: async argv => { handed.push(argv); return 0; } };
  const press = async (...list: Key[]): Promise<void> => { for (const key of list) { for (const cb of keys) cb(key); await Bun.sleep(20); } };
  const type = async (text: string): Promise<void> => { await press(...[...text].map(ch => ({ name: "char", text: ch }))); };
  const text = (): string => {
    const s = state.screen;
    if (s === null) return "";
    const plain = (rows: string[]): string => Bun.stripANSI(rows.join("\n"));
    return s.kind === "page" ? plain(s.rows) : plain([...s.items.flatMap(i => i.kind === "fold" ? [i.title, ...i.rows] : i.rows), ...s.tail, ...s.footer]);
  };
  const shows = async (wanted: string, ms = 1000): Promise<string> => {
    for (let waited = 0; waited < ms && !text().includes(wanted); waited += 20) await Bun.sleep(20);
    return text();
  };
  const dismiss = async (): Promise<void> => { if ((await shows("bubble for this chat", 300)).includes("bubble for this chat")) await press({ name: "escape" }); };
  const act = async (action: screens.ScreenAction): Promise<void> => { for (const cb of acts) cb(action); await Bun.sleep(20); };
  return { terminal, press, type, text, shows, act, dismiss, screen: (): screens.Screen | null => state.screen };
}

async function app(dir: string) {
  const t = fakeTerminal();
  const started: string[] = [];
  const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async c => { started.push(c); return { ok: true, data: 0 }; }, clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
  await a.start();
  await t.dismiss();
  return { ...t, app: a, started };
}

describe("tui", () => {
  test("Enter sends input to the orchestrator, shown at once in the chat while nothing runs; Tab queues it for after the work; Esc takes the newest back", async () => {
    await setTrust(home.path(), false);
    const t = await app(home.path());
    await t.type("hello");
    await t.press({ name: "enter" });
    await t.type("later");
    await t.press({ name: "tab" });
    const id = t.app.conversationId();
    const queued = (await pending(id, "orchestrator")).map(i => `${i.message.delivery}:${i.message.text}`);
    expect(queued).toEqual(["steer:hello", "steer:later"]);
    expect(t.started.length).toBeGreaterThan(0);
    await t.app.poll();
    expect(t.text()).not.toContain("queued");
    const screen = t.screen();
    expect(screen?.kind === "chat" ? screen.items.filter(item => item.kind === "user").map(item => item.rows.join(" ")) : []).toEqual(["hello", "later"]);
    await t.press({ name: "escape" });
    expect((await pending(id, "orchestrator")).map(i => i.message.text)).toEqual(["hello"]);
    expect(t.text()).toContain("› later");
    t.app.stop();
  });

  test("a new folder opens without a trust question; a plugin tab, its count and its command work", async () => {
    registerBuiltins(BUILTINS);
    await saveConfig({ plugins: ["example"] });
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-folder-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    await t.dismiss();
    expect(t.text()).not.toContain("Trust ");
    await t.type("/pin buy milk");
    await t.press({ name: "enter" });
    await a.refresh();
    expect(t.text()).toContain("1 pin");
    await t.press({ name: "a", ctrl: true });
    expect(t.text()).toContain("[Agents]");
    await t.press({ name: "tab" });
    expect(t.text()).toContain("[Pins]");
    expect(t.text()).toContain("buy milk");
    a.stop();
  });

  test("/effort and /fast open v1's menus: the current choice marked and selected, Enter saves it for the chat and the header shows it", async () => {
    await saveConfig({ model: "claude-opus-5-5" });
    const t = await app(home.path());
    await t.type("/effort");
    await t.press({ name: "enter" });
    const menu = await t.shows("effort for claude-opus-5-5");
    expect(menu).toContain("↑↓ enter   esc cancels");
    expect(menu).toMatch(/❯ ● default/);
    await t.press({ name: "down" }, { name: "down" }, { name: "enter" });
    await t.shows("effort for claude-opus-5-5: medium");
    const account = (): string => { const s = t.screen(); return s !== null && s.kind === "chat" ? s.header?.account ?? "" : ""; };
    expect(account()).toContain("claude-opus-5-5 · medium");
    const id = t.app["conversation"].id;
    expect((await readConversation(id))?.effort).toBe("medium");
    await t.type("/effort");
    await t.press({ name: "enter" });
    expect(await t.shows("❯ ● medium")).toContain("❯ ● medium");
    await t.press({ name: "escape" });
    await t.type("/fast");
    await t.press({ name: "enter" });
    expect(await t.shows("❯ ● off")).toContain("fast mode for claude-opus-5-5");
    await t.press({ name: "down" }, { name: "enter" });
    await t.shows("fast for claude-opus-5-5: on");
    expect(account()).toContain("claude-opus-5-5 · medium · fast");
    expect((await readConversation(id))?.fast).toBe(true);
    await t.type("/effort turbo");
    await t.press({ name: "enter" });
    expect(await t.shows("unsupported")).toContain("effort turbo is unsupported for claude-opus-5-5");
    await saveConfig({ model: "claude-sonnet-5-5" });
  });

  test("/login offers the providers and waits for the browser sign-in, Esc cancels it; with no accounts /accounts says so", async () => {
    const t = await app(home.path());
    await t.type("/login");
    await t.press({ name: "enter" });
    expect(await t.shows("sign in   (/login")).toMatch(/❯ anthropic/);
    await t.press({ name: "enter" });
    const waiting = await t.shows("waiting for login");
    expect(waiting).toContain("http://localhost:53692/login/");
    expect(waiting).toContain("esc cancels");
    await t.press({ name: "escape" });
    expect(await t.shows("login cancelled")).not.toContain("waiting for login");
    await t.type("/login gemini");
    await t.press({ name: "enter" });
    await t.shows("/usage: login anthropic|openai");
    await t.type("/accounts");
    await t.press({ name: "enter" });
    expect(await t.shows("no accounts")).toContain("no accounts; /login signs in");
  });

  test("/mux is a core command: it offers plain and the enabled runner plugins and saves runner", async () => {
    registerBuiltins(BUILTINS);
    await saveConfig({ plugins: ["tmux"], runner: "plain" });
    const t = await app(home.path());
    await t.type("/mux rex");
    await t.press({ name: "enter" });
    expect(await t.shows("unknown runner rex")).toContain("unknown runner rex; choose plain, tmux");
    await t.type("/mux tmux");
    await t.press({ name: "enter" });
    expect((await loadConfig()).runner).toBe("tmux");
    expect(await t.shows("new agents start in tmux")).toContain("new agents start in tmux");
    await saveConfig({ plugins: [], runner: "plain" });
    t.app.stop();
  });

  test("a plugin hook's question is shown and answered from the TUI", async () => {
    const t = await app(home.path());
    const id = t.app.conversationId();
    const answer = askUser(id, "worker-x", "deploy to staging?", new AbortController().signal, 5000);
    await Bun.sleep(50);
    await t.app.poll();
    expect(t.text()).toContain("worker-x asks: deploy to staging?");
    await t.press({ name: "char", text: "y" });
    expect(await answer).toBe(true);
    expect(await pendingConfirms(id)).toEqual([]);
    t.app.stop();
  });

  test("a failed turn's error shows in full above the input, in red, never in the header", async () => {
    const t = await app(home.path());
    const error = "anthropic:default: The sign-in service rejected the credential exchange. Sign in again. Sign-in HTTP 400. Sign in again with: orca2 login anthropic default";
    await writeStatus(t.app.conversationId(), { pid: 1, run: "r", build: "test", state: "idle", since: "", turns: 1, error, contextTokens: null, phase: null });
    await t.app.poll();
    const screen = t.screen();
    expect(screen?.kind).toBe("chat");
    if (screen?.kind !== "chat") return;
    expect(JSON.stringify(screen.header)).not.toContain("failed");
    const footer = Bun.stripANSI(screen.footer.join(" "));
    expect(footer).toContain("last turn failed:");
    expect(footer.replace(/\s+/g, " ")).toContain("orca2 login anthropic default");
    expect(screen.footer.some(row => row.includes("\x1b[38;5;217m"))).toBe(true);
    await t.press({ name: "char", text: "x" });
    expect(Bun.stripANSI((t.screen()?.kind === "chat" ? t.text() : ""))).not.toContain("last turn failed");
    t.app.stop();
  });

  test("a new chat shows the whale; Ctrl+B lists bubbles with their chats; Ctrl+N asks which bubble the new chat joins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-bubbles-"));
    const other = await createConversation(dir, "notes chat");
    const bubble = await ensureBubble(other.id);
    expect(bubble.ok).toBe(true);
    if (!bubble.ok) return;
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    const first = t.screen();
    expect(first?.kind === "chat" ? first.welcome.join("\n") : "").toContain("#####");
    await t.press({ name: "b", ctrl: true });
    expect(t.text()).toContain("[Bubbles]");
    expect(t.text()).toContain("notes chat");
    await t.press({ name: "escape" });
    await t.press({ name: "n", ctrl: true });
    expect(t.text()).toContain("bubble for the new chat");
    expect(t.text()).toContain("New bubble");
    await t.press({ name: "down" }, { name: "enter" });
    await Bun.sleep(50);
    expect((await readConversation(a.conversationId()))?.bubble).toBe(bubble.data.id);
    expect(a.conversationId()).not.toBe(other.id);
    await t.press({ name: "b", ctrl: true });
    expect(t.text()).toContain("2 chats");
    a.stop();
  });

  test("Ctrl+N opens a new chat as another header tab; Ctrl+H/Ctrl+L and Alt+←/→ switch between them; /close closes the open one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-tabs-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    const tabs = (): { label: string; active: boolean }[] => { const s = t.screen(); return s?.kind === "chat" && s.header !== null ? s.header.tabs.map(x => ({ label: x.label, active: x.active })) : []; };
    const first = a.conversationId();
    const newChat = async (): Promise<void> => {
      await t.press({ name: "n", ctrl: true });
      await t.shows("bubble for the new chat");
      await t.press({ name: "enter" });
      await t.shows("name the new bubble");
      await t.press({ name: "enter" });
      await t.shows("new bubble ");
    };
    await newChat();
    const second = a.conversationId();
    await newChat();
    expect(tabs().map(x => x.label)).toEqual([first, second, a.conversationId()]);
    expect(tabs().findIndex(x => x.active)).toBe(2);
    await t.press({ name: "h", ctrl: true });
    expect(a.conversationId()).toBe(second);
    await t.press({ name: "h", ctrl: true });
    expect(a.conversationId()).toBe(first);
    await t.press({ name: "l", ctrl: true }, { name: "l", ctrl: true }, { name: "left", alt: true });
    expect(a.conversationId()).toBe(second);
    await t.type("/close");
    await t.press({ name: "enter" });
    expect(tabs().length).toBe(2);
    expect(tabs().map(x => x.label)).not.toContain(second);
    a.stop();
  });

  test("opening orca2 in a folder shows every chat of that folder as a tab, oldest first, on the newest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-all-"));
    const older = await createConversation(dir, "older");
    await Bun.sleep(5);
    const newer = await createConversation(dir, "newer");
    await createConversation(home.path(), "elsewhere");
    const t = await app(dir);
    const s = t.screen();
    const tabs = s?.kind === "chat" && s.header !== null ? s.header.tabs : [];
    expect(tabs.map(x => x.label)).toEqual(["older", "newer"]);
    expect(t.app.conversationId()).toBe(newer.id);
    await t.press({ name: "h", ctrl: true });
    expect(t.app.conversationId()).toBe(older.id);
    t.app.stop();
  });

  test("/rename renames the open chat everywhere it shows, and its bubble while that still has the old name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-rename-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    const bubble = await ensureBubble(a.conversationId());
    expect(bubble.ok).toBe(true);
    await t.type("/rename   raven  work ");
    await t.press({ name: "enter" });
    expect((await readConversation(a.conversationId()))?.name).toBe("raven work");
    const screen = t.screen();
    expect(screen?.kind === "chat" && screen.header !== null ? screen.header.tabs.map(x => x.label) : []).toEqual(["raven work"]);
    expect(bubble.ok ? (await readBubble(bubble.data.id))?.name : "").toBe("raven work");
    await t.type("/rename");
    await t.press({ name: "enter" });
    expect(t.text()).toContain("rename to raven work");
    a.stop();
  });

  test("a folder's first chat asks which of that folder's bubbles it joins (never another folder's); d on the Bubbles tab deletes a chat after y", async () => {
    const elsewhere = await createConversation(mkdtempSync(join(tmpdir(), "orca2-tui-other-")), "shared notes");
    const shared = await ensureBubble(elsewhere.id);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-first-"));
    const foreign = await ensureBubble((await createConversation(mkdtempSync(join(tmpdir(), "orca2-tui-foreign-")), "foreign")).id);
    expect((await setBubbleDirectory(shared.data.id, dir)).ok).toBe(true);
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    await Bun.sleep(50);
    expect(t.text()).toContain("bubble for this chat");
    expect(foreign.ok && t.text().includes(foreign.data.name)).toBe(false);
    const options = t.text().split("\n").filter(line => line.includes("· ") && line.includes("chats"));
    const at = options.findIndex(line => line.includes(shared.data.name));
    await t.press(...Array.from({ length: at + 1 }, () => ({ name: "down" })), { name: "enter" });
    await Bun.sleep(50);
    const first = a.conversationId();
    expect((await readConversation(first))?.bubble).toBe(shared.data.id);
    await a.refresh();
    expect(t.text()).toContain("0 agents │ 1 bubble");
    await t.press({ name: "b", ctrl: true });
    for (let i = 0; i < 40 && !t.text().split("\n").some(line => line.startsWith("› ") && /[├└]─ shared notes/.test(line)); i++) await t.press({ name: "char", text: "j" });
    await t.press({ name: "char", text: "d" });
    expect(t.text()).toContain("delete chat shared notes?");
    await t.press({ name: "char", text: "y" });
    await Bun.sleep(50);
    expect(await readConversation(elsewhere.id)).toBeNull();
    expect(a.conversationId()).toBe(first);
    a.stop();
  });

  test("Shift+Enter (or Alt+Enter) adds a new line in the composer instead of sending", async () => {
    const t = await app(mkdtempSync(join(tmpdir(), "orca2-tui-newline-")));
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    const id = t.app.conversationId();
    await t.type("first");
    await t.press({ name: "enter", shift: true });
    await t.type("second");
    await t.press({ name: "enter", alt: true });
    await t.type("third");
    expect(await pending(id, "orchestrator")).toEqual([]);
    await t.press({ name: "enter" });
    expect((await pending(id, "orchestrator")).map(i => i.message.text)).toEqual(["first\nsecond\nthird"]);
    t.app.stop();
  });

  test("a plugin tab archives with a (rows move under a closed Archived heading), Enter opens it, u restores, A archives all after y", async () => {
    registerBuiltins(BUILTINS);
    await saveConfig({ plugins: ["example"] });
    const t = await app(mkdtempSync(join(tmpdir(), "orca2-tui-archive-")));
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    for (const text of ["/pin first", "/pin second"]) { await t.type(text); await t.press({ name: "enter" }); }
    await t.press({ name: "a", ctrl: true }, { name: "tab" });
    expect(await t.shows("[Pins]")).toContain("second");
    await t.press({ name: "char", text: "a" });
    expect(await t.shows("Archived (1)")).toContain("▸ Archived (1)");
    expect(t.text()).toContain("archived first");
    expect(t.text().split("\n").filter(line => line.includes("first") && !line.includes("archived first") && !line.startsWith("──"))).toEqual([]);
    await t.press({ name: "down" }, { name: "enter" });
    expect(await t.shows("▾ Archived (1)")).toContain("▾ Archived (1)");
    await t.press({ name: "down" }, { name: "char", text: "u" });
    expect(await t.shows("restored first")).not.toContain("Archived (");
    await t.press({ name: "char", text: "A" });
    expect(t.text()).toContain("archive all 2 on this tab?");
    await t.press({ name: "char", text: "y" });
    expect(await t.shows("Archived (2)")).toContain("▾ Archived (2)");
    await saveConfig({ plugins: [] });
    t.app.stop();
  });

  test("a finished selection is copied to the clipboard and a clicked link opens in the browser; only web and mail links open", async () => {
    const copied: string[] = [], opened: string[] = [];
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: mkdtempSync(join(tmpdir(), "orca2-tui-copy-")), now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }),
      clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async text => { copied.push(text); return { ok: true, data: null }; },
      openUrl: async url => { opened.push(url); return { ok: true, data: null }; }, open: async () => {}, exit: () => {} });
    await a.start();
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    await t.act({ kind: "copy", text: "hello there" });
    expect(copied).toEqual(["hello there"]);
    expect(await t.shows("copied 11 characters")).toContain("copied 11 characters");
    await t.act({ kind: "link", url: "https://github.com/wabarurse/orca/pull/1" });
    expect(opened).toEqual(["https://github.com/wabarurse/orca/pull/1"]);
    await t.act({ kind: "link", url: "file:///etc/passwd" });
    expect(opened.length).toBe(1);
    expect(await t.shows("not opened")).toContain("not opened: file:///etc/passwd");
    a.stop();
  });

  test("a new chat offers New bubble (created at once, named after the folder, shown in the top bar), this folder's bubbles, and No bubble (which memory cannot undo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-newbubble-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }),
      copy: async () => ({ ok: true, data: null }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, exit: () => {} });
    await a.start();
    expect(await t.shows("bubble for this chat")).toContain("No bubble (no shared memory)");
    await t.press({ name: "enter" });
    expect(t.text()).toContain(`name the new bubble: ${basename(dir)}`);
    await t.press({ name: "enter" });
    await Bun.sleep(50);
    const first = await readConversation(a.conversationId());
    const made = first?.bubble == null ? null : await readBubble(first.bubble);
    expect(made?.name).toBe(basename(dir));
    expect(made?.directory).toBe(dir);
    await a.refresh();
    const header = (): string => { const screen = t.screen(); return screen?.kind === "chat" && screen.header !== null ? screen.header.bubble ?? "" : ""; };
    expect(header()).toBe(`bubble ${basename(dir)}`);

    await t.press({ name: "n", ctrl: true });
    expect(await t.shows("bubble for the new chat")).toContain(basename(dir));
    await t.press({ name: "down" }, { name: "down" }, { name: "enter" });
    await Bun.sleep(50);
    const none = await readConversation(a.conversationId());
    expect(none?.noBubble).toBe(true);
    expect(none?.bubble).toBeNull();
    await a.refresh();
    expect(header()).toBe("no bubble");
    const ensured = await ensureBubble(a.conversationId());
    expect(ensured.ok ? "" : ensured.error).toContain("this chat has no bubble");
    a.stop();
  });

  test("the footer counts plugins at its right; Ctrl+P lists them with their pages, Enter opens one, t turns it off for the bubble", async () => {
    registerBuiltins(BUILTINS);
    await saveConfig({ plugins: ["example"] });
    const t = await app(mkdtempSync(join(tmpdir(), "orca2-tui-plugins-")));
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    await t.app.refresh();
    const screen = t.screen();
    const footer = screen?.kind === "chat" ? Bun.stripANSI(screen.footer.join("\n")) : "";
    expect(footer).toMatch(/0 agents.* 1 plugin · Ctrl\+P │/);
    await t.press({ name: "p", ctrl: true });
    expect(await t.shows("[Plugins]")).toContain("example");
    expect(t.text()).toMatch(/example\s+on\s+Pins/);
    await t.press({ name: "enter" });
    expect(await t.shows("[Pins]")).toContain("[Pins]");
    await t.press({ name: "escape" }, { name: "p", ctrl: true });
    await t.press({ name: "char", text: "t" });
    expect(await t.shows("example off for this bubble")).toMatch(/example\s+off/);
    await t.press({ name: "escape" });
    const after = t.screen();
    expect(after?.kind === "chat" ? Bun.stripANSI(after.footer.join("\n")) : "").toContain("0 plugins · Ctrl+P");
    await saveConfig({ plugins: [] });
    t.app.stop();
  });
});
