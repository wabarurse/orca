import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
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
  const state: { screen: screens.Screen | null } = { screen: null };
  const terminal: Terminal = { cols: 100, rows: 30, write() {}, onKey: cb => { keys.push(cb); }, onResize() {}, open() {}, close() {}, eraseOnExit() {},
    show: screen => { state.screen = screen; }, scroll() {}, onAction() {}, selection: () => "" };
  const press = async (...list: Key[]): Promise<void> => { for (const key of list) { for (const cb of keys) cb(key); await Bun.sleep(20); } };
  const type = async (text: string): Promise<void> => { await press(...[...text].map(ch => ({ name: "char", text: ch }))); };
  const text = (): string => {
    const s = state.screen;
    if (s === null) return "";
    const plain = (rows: string[]): string => Bun.stripANSI(rows.join("\n"));
    return s.kind === "page" ? plain(s.rows) : plain([...s.items.flatMap(i => i.kind === "fold" ? [i.title, ...i.rows] : i.rows), ...s.tail, ...s.footer]);
  };
  return { terminal, press, type, text, screen: (): screens.Screen | null => state.screen };
}

async function app(dir: string) {
  const t = fakeTerminal();
  const started: string[] = [];
  const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async c => { started.push(c); return { ok: true, data: 0 }; }, clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
  await a.start();
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
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
    await a.start();
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
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
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

  test("Ctrl+N opens a new chat as another header tab; Alt+← switches back; /close closes the open one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-tabs-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
    await a.start();
    const tabs = (): { label: string; active: boolean }[] => { const s = t.screen(); return s?.kind === "chat" && s.header !== null ? s.header.tabs.map(x => ({ label: x.label, active: x.active })) : []; };
    const first = a.conversationId();
    await t.press({ name: "n", ctrl: true }, { name: "enter" });
    const second = a.conversationId();
    await t.press({ name: "n", ctrl: true }, { name: "enter" });
    expect(tabs().map(x => x.label)).toEqual([first, second, a.conversationId()]);
    expect(tabs().findIndex(x => x.active)).toBe(2);
    await t.press({ name: "left", alt: true });
    expect(a.conversationId()).toBe(second);
    await t.type("/close");
    await t.press({ name: "enter" });
    expect(tabs().length).toBe(2);
    expect(tabs().map(x => x.label)).not.toContain(second);
    a.stop();
  });

  test("/rename renames the open chat everywhere it shows, and its bubble while that still has the old name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca2-tui-rename-"));
    const t = fakeTerminal();
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
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
    const a = new App({ terminal: t.terminal, directory: dir, now: () => 0, ensureDaemon: async () => ({ ok: true, data: 0 }), clipboard: async () => ({ ok: false, error: "clipboard is empty." }), exit: () => {} });
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
});
