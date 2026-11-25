import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig, paths, saveConfig } from "../config";
import { askUser, pendingConfirms } from "../core/confirm";
import { writeStatus } from "../core/daemon/channel";
import { ensureBubble, readBubble, setBubbleDirectory } from "../core/bubbles";
import { createConversation, readConversation } from "../core/conversations";
import { pending } from "../core/inbox";
import { registerBuiltins } from "../core/plugins";
import { setTrust } from "../core/trust";
import { openTranscript } from "../core/transcript";
import { EXAMPLE, runnerPlugin } from "../test/plugins";
import { tempHome } from "../test/home";
import { App } from "./app";
import { selectionMarks, type Key, type screens, type Terminal } from "./components";

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
  const stopped: string[] = [];
  const exits: number[] = [];
  const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async c => { started.push(c); return { ok: true, data: 0 }; }, clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), pasteText: async () => ({ ok: false, error: "clipboard is empty." }), openUrl: async () => ({ ok: true, data: null }), open: async () => {},
    stopAgents: async c => { stopped.push(c); return []; }, exit: code => { exits.push(code); } });
  await a.start();
  await t.dismiss();
  return { ...t, app: a, started, stopped, exits };
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
    registerBuiltins([EXAMPLE]);
    await saveConfig({ plugins: ["example"] });
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-folder-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), copy: async () => ({ ok: true, data: null }), pasteText: async () => ({ ok: false, error: "clipboard is empty." }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, stopAgents: async () => [], exit: () => {} });
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
    registerBuiltins([runnerPlugin("tmux")]);
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

  test("Up/Down recall earlier input (messages and commands) only from an empty composer; over typed text they only move the cursor", async () => {
    const t = await app(mkdtempSync(join(tmpdir(), "orca2-tui-history-")));
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    const composer = (): string => t.text().split("\n").filter(line => line.includes("› ")).join("\n");
    await t.type("one");
    await t.press({ name: "enter" });
    await t.type("/nope");
    await t.press({ name: "enter" });
    await t.press({ name: "up" });
    expect(composer()).toContain("› /nope");
    await t.press({ name: "up" });
    expect(composer()).toContain("› one");
    await t.press({ name: "down" });
    expect(composer()).toContain("› /nope");
    await t.press({ name: "down" });
    expect(composer()).not.toContain("/nope");
    expect(composer()).not.toContain("one");
    await t.type("draft");
    await t.press({ name: "up" });
    expect(composer()).toContain("› draft");
    await t.press({ name: "char", text: "!" });
    expect(composer()).toContain("› !draft");
    await t.press({ name: "end" }, { name: "enter", shift: true }, { name: "char", text: "x" }, { name: "up" }, { name: "char", text: "?" });
    expect(composer()).toContain("› !?draft");
    await t.press({ name: "down" }, { name: "down" });
    expect(composer()).not.toContain("/nope");
    t.app.stop();
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

  test("a tab action's pick shows every option on the work page with the selection highlighted; j moves it, Enter sends it, a digit picks at once, Esc cancels", async () => {
    registerBuiltins([EXAMPLE]);
    await saveConfig({ plugins: ["example"] });
    const t = await app(mkdtempSync(join(tmpdir(), "orca2-tui-pick-")));
    await Bun.sleep(50);
    await t.press({ name: "escape" });
    await t.type("/pin first");
    await t.press({ name: "enter" });
    await t.press({ name: "a", ctrl: true }, { name: "tab" });
    expect(await t.shows("[Pins]")).toContain("first");
    await t.press({ name: "char", text: "b" });
    const shown = await t.shows("who pinned p1?");
    expect(shown).toContain("❯ 1 ● user");
    expect(shown).toContain("  2   agent");
    expect(shown).toContain("1-2 picks   esc cancels");
    const screen = t.screen();
    expect(screen?.kind === "page" ? screen.rows.filter(r => r.includes(selectionMarks().on)).map(r => Bun.stripANSI(r)) : []).toEqual(["❯ 1 ● user"]);
    await t.press({ name: "char", text: "j" });
    expect(await t.shows("❯ 2   agent")).toContain("  1 ● user");
    await t.press({ name: "enter" });
    expect(await t.shows("p1 pinned by agent")).not.toContain("who pinned p1?");
    await t.press({ name: "char", text: "b" });
    expect(await t.shows("❯ 2 ● agent")).toContain("who pinned p1?");
    await t.press({ name: "escape" });
    expect(t.text()).not.toContain("who pinned p1?");
    await t.press({ name: "char", text: "b" });
    await t.shows("who pinned p1?");
    await t.press({ name: "char", text: "1" });
    expect(await t.shows("p1 pinned by user")).toContain("user");
    await saveConfig({ plugins: [] });
    t.app.stop();
  });

  test("a plugin tab archives with a (rows move under a closed Archived heading), Enter opens it, u restores, A archives all after y", async () => {
    registerBuiltins([EXAMPLE]);
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
      pasteText: async () => ({ ok: false, error: "clipboard is empty." }), openUrl: async url => { opened.push(url); return { ok: true, data: null }; }, open: async () => {}, stopAgents: async () => [], exit: () => {} });
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
      copy: async () => ({ ok: true, data: null }), pasteText: async () => ({ ok: false, error: "clipboard is empty." }), openUrl: async () => ({ ok: true, data: null }), open: async () => {}, stopAgents: async () => [], exit: () => {} });
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
    registerBuiltins([EXAMPLE]);
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
