import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { askUser, pendingConfirms } from "../core/confirm";
import { writeStatus } from "../core/daemon/channel";
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
    await writeStatus(t.app.conversationId(), { pid: 1, run: "r", state: "idle", since: "", turns: 1, error, contextTokens: null, phase: null });
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
});
