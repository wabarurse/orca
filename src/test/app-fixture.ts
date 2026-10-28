import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/agent-loop/orc";
import type { Message } from "../protocol";
import { paths } from "../config";
import { App, type Line } from "../tui/app";
import { parseKeys, type Key } from "../tui/components/keys";
import type { Terminal } from "../tui/components/term";
import { FakeScreen } from "../tui/components/testing";
import { setUserFill } from "../tui/components/style";

/** Called once per test file: hooks, temporary state and terminal failures stay local. */
export function appFixture() {
  const home = mkdtempSync(join(tmpdir(), "orca-tui-"));
  process.env.ORCA_HOME = home;
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** Anything the fake screen refused (an escape or control a real terminal would misread); checked after every test. */
  const screenErrors: string[] = [];
  afterEach(() => { expect(screenErrors).toEqual([]); screenErrors.length = 0; });
  /** The user background on, whatever the environment says, so every test draws it (and pads the input). */
  const USER_BG = "\x1b[48;5;236m";
  beforeEach(() => setUserFill(USER_BG));

  const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");
  /** A history line's text: plain lines as they are, markdown as written. */
  const raw = (l: Line) => (typeof l === "string" ? l : "user" in l ? l.user : "tool" in l ? `${l.tool} ⎿ ${l.summary}` : l.md);

  /** A fake terminal: records every raw write and applies it to a FakeScreen, so `screen()` is the scrollback plus the screen. */
  function fakeTerm(cols = 40, rows = 24) {
    const handlers: ((k: Key) => void)[] = [];
    const resizers: (() => void)[] = [];
    const display = new FakeScreen(cols, rows);
    const writes: string[] = [];
    const term: Terminal & { type(s: string): void; press(k: Key): void; screen(): string; raw(): string; writes: string[]; display: FakeScreen; resize(cols: number, rows: number): void; eraser: string; opened: boolean; closed: boolean } = {
      cols, rows, opened: false, closed: false, writes, display, eraser: "",
      eraseOnExit(text) { this.eraser = text; },
      write: (s) => {
        writes.push(s);
        try { display.write(s); } catch (err) { screenErrors.push(String(err)); throw err; }
      },
      onKey: (cb) => { handlers.push(cb); },
      onResize: (cb) => { resizers.push(cb); },
      resize(c, r) { this.cols = c; this.rows = r; display.resize(c, r); for (const cb of resizers) cb(); },
      open() { this.opened = true; this.write("\x1b[?1049h"); },
      close() { this.write("\x1b[?1049l"); this.closed = true; },
      press: (k) => { for (const h of handlers) h(k); },
      type: (s) => { for (const k of parseKeys(s)) for (const h of handlers) h(k); },
      screen: () => display.text(),
      raw: () => writes.join(""),
    };
    return term;
  }

  /** The chapter's closing rule separates pinned metadata from the body. */
  const bodyStart = (term: ReturnType<typeof fakeTerm>) => term.display.screen().findIndex(row => /^─+$/.test(row)) + 1;
  const bodyRows = (term: ReturnType<typeof fakeTerm>) => term.display.screen().slice(bodyStart(term));

  /** Click the screen row showing `text` (one press and release on the same cell). */
  async function clickRow(app: App, term: ReturnType<typeof fakeTerm>, text: string): Promise<void> {
    const y = term.display.screen().findIndex(row => row.includes(text)) + 1;
    expect(y).toBeGreaterThan(0);
    await app.onKey({ name: "mousedown", x: 3, y });
    await app.onKey({ name: "mouseup", x: 3, y });
  }

  function fakeOrchestrators() {
    const opened: { project: string; url?: string }[] = [];
    const said: Record<string, string[]> = {};
    const writers: Record<string, (t: string) => void> = {};
    const openOrchestrator = async (project: string, url: string | undefined, write: (t: string) => void, onInbox?: (msgs: Message[]) => void): Promise<Orchestrator> => {
      mkdirSync(paths.project(project), { recursive: true });
      opened.push({ project, url });
      said[project] = [];
      writers[project] = write;
      let queued = 0;
      let consumed = 0;
      const ids: (string | undefined)[] = [];
      return {
        async say(text, _submission, inputId) { said[project]!.push(text); ids.push(inputId); queued++; },
        async pending() { return queued > 0; },
        async turn() {
          queued = 0;
          onInbox?.(said[project]!.slice(consumed).map((text, i) => ({ from: "user", text, inputId: ids[consumed + i], ts: "" })));
          consumed = said[project]!.length;
          write(`${project} says hi\n`);
          return [{ from: "worker-x", text: "done", ts: "t" }];
        },
      };
    };
    return { opened, said, writers, openOrchestrator };
  }

  const settle = () => Bun.sleep(15);
  /** A real terminal's clock whose background-reply window ends at once, as for a terminal that never answers (term.test.ts covers the window). */
  const NO_REPLY_WINDOW = { now: Date.now, setTimer: (fn: () => void) => { fn(); return () => {}; } };
  /** Wait until `cond` holds, up to two seconds. */
  async function until(cond: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!cond() && Date.now() < deadline) await Bun.sleep(5);
    expect(cond()).toBe(true);
  }
  return { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until };
}
