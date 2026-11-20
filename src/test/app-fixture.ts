import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/agent-loop/orc";
import type { Message } from "../protocol";
import { paths } from "../config";
import { App, type Line } from "../tui/app";
import { parseKeys, type Key } from "../tui/components/keys";
import { testTerminal } from "./otui-term";
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
  const raw = (l: Line) => (typeof l === "string" ? l : "user" in l ? l.user : "tool" in l ? `${l.tool} ⎿ ${l.summary}` : "from" in l ? `from ${l.from}: ${l.text}` : "image" in l ? l.image : l.md);

  /** A terminal drawn by OpenTUI's test renderer (src/test/otui-term.ts): `screen()` is the rendered frame, `display.screen()` its rows. */
  function fakeTerm(cols = 40, rows = 24) {
    const term = testTerminal(cols, rows);
    return Object.assign(term, { display: { screen: () => term.lines() }, raw: () => term.writes.join("") });
  }

  /** The header is a box open at the top (tabs, account, details) closed by its bottom line; the body starts under it. */
  const bodyStart = (term: ReturnType<typeof fakeTerm>) => {
    const at = term.display.screen().findIndex(row => row.startsWith("└"));
    return at === -1 ? 0 : at + 1;
  };
  const bodyRows = (term: ReturnType<typeof fakeTerm>) => term.display.screen().slice(bodyStart(term));
  /** The selected tab: the bold pill in the header's first row ("" when no header is drawn). */
  const selectedTab = (term: ReturnType<typeof fakeTerm>) => bodyStart(term) ? term.bold(0) : "";

  /** Click the screen row showing `text` on its first character, through OpenTUI's mouse. */
  async function clickRow(_app: App, term: ReturnType<typeof fakeTerm>, text: string): Promise<void> {
    const rows = term.display.screen(), y = rows.findIndex(row => row.includes(text));
    expect(y).toBeGreaterThan(-1);
    await term.click(Bun.stringWidth(rows[y]!.slice(0, rows[y]!.indexOf(text))) + 1, y + 1);
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
  /** The Projects tab of the work page as its rows (null while another tab or no page shows): id, shown label, pin, the status line. */
  const projectList = (app: App) => {
    const state = app.work.kind === "projects" ? app.work.state : null;
    return state && { items: state.items.map(item => ({ name: item.id, label: item.name, pinned: item.lead === "★ " })), index: state.index, status: state.notice ?? "", confirm: state.confirm ?? null };
  };

  return { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, selectedTab, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until, projectList };
}
