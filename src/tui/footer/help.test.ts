import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../app";
import { chapterRows, headerHeight } from "../header/chrome";
import { helpLines } from "./help";
import { helpPanel, liveRows, type Frame } from "./render";
import { stickyRows, stickyUpdate } from "../screen/sticky";
import { setUserFill } from "../components/style";
import type { Terminal } from "../components/term";
import { FakeScreen } from "../components/testing";

// Visual review: __snapshots__/help.test.ts.snap contains the 80x24 and 40x24
// pinned screens, full content at both widths, and the scrolled diagnostic tail.
// Verify with `bun test src/tui/footer/help.test.ts`; use -u only for intentional edits.
// Pure fixture: no run/openPage, disk reads, tmux, login, or model calls.
const term: Terminal = { cols: 80, rows: 24, write() {}, onKey() {}, onResize() {}, open() {}, close() {}, eraseOnExit() {} };
const commands = new App({ term, openOrchestrator: async () => { throw new Error("render-only fixture"); } }).commands;
const plain = (rows: string[]) => rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
const frame = (cols: number, rows: number, top = 0): Frame => ({
  cols, rows, menu: null,
  input: { prompt: "> ", text: "draft 界", cursor: 5 },
  status: "2 agents running │ 1 task │ inbox 1",
  help: { lines: helpLines(commands, false, cols), top },
});
const chrome = (f: Frame) => chapterRows({ tabs: [{ name: "demo" }], active: 0, model: "example-model · effort default · fast off", directory: "/isolated/demo", remote: "example/repo" }, f.cols, headerHeight(f.rows));
const history = Array.from({ length: 30 }, (_, i) => `Conversation record ${i + 1}`);
afterEach(() => setUserFill(null));

describe("help appearance fixtures", () => {
  for (const cols of [80, 40]) {
    test(`${cols}x24: help starts below boxed composer and counts, with conversation still visible`, () => {
      const f = frame(cols, 24);
      const screen = stickyRows(f, history, chrome(f));
      expect(plain(screen.rows)).toMatchSnapshot();
      const rows = screen.rows.map(Bun.stripANSI);
      expect(rows.findIndex(row => row.startsWith("help"))).toBeGreaterThan(rows.findIndex(row => row.startsWith("└")));
      const footerAt = rows.findIndex(row => row.startsWith("┌"));
      expect(rows.slice(footerAt - 2, footerAt)).toEqual(["Conversation record 30", ""]);
      expect(screen.bodyHeight).toBe(footerAt - chrome(f).length - 1);
      expect(screen.bodyHeight).toBeGreaterThanOrEqual(2);
      expect(rows[screen.cursor]).toContain("draft 界");
    });
    test(`${cols} columns: full grouped content, including less prominent diagnostics`, () => {
      const lines = helpLines(commands, false, cols);
      expect(plain(lines)).toMatchSnapshot();
      const advanced = lines.slice(lines.findIndex(row => row.includes("advanced & diagnostics")));
      expect(advanced.every(row => !row || row.includes("\x1b[2m"))).toBe(true);
      expect(advanced.join("\n")).not.toContain("\x1b[1m");
      for (const [name, command] of commands) {
        if (!command.help.viewOnly) expect(plain(lines)).toContain(name);
      }
      expect(plain(lines).replace(/\s+/g, " ")).toContain("click ▸ open a run of tool calls");
    });
  }
  test("End reaches diagnostics with a bounded range and dismissal hint", () => {
    const f = frame(80, 24, Infinity);
    expect(plain(stickyRows(f, history, chrome(f)).rows)).toMatchSnapshot();
    const panel = helpPanel({ ...f, rows: 19 });
    expect(panel.top).toBe(panel.maxTop);
    expect(plain(panel.rows)).toContain("/review-rounds");
    expect(plain(panel.rows)).toContain("esc close");
  });
});

test("help wraps without overflow and sticky geometry/cursor survive tiny terminals and repeated resizing", () => {
  setUserFill("\x1b[48;5;236m");
  const screen = new FakeScreen(80, 24);
  for (const [cols, rows] of [[80, 24], [40, 24], [20, 12], [12, 8], [8, 4], [4, 3], [2, 2], [1, 1], [120, 40]]) {
    const f = frame(cols!, rows!);
    expect(f.help!.lines.every(row => Bun.stringWidth(row) <= cols!)).toBe(true);
    const next = stickyRows(f, history, chrome(f));
    expect(next.rows).toHaveLength(rows!);
    expect(next.rows.every(row => Bun.stringWidth(row) <= cols!)).toBe(true);
    expect(next.cursor).toBeGreaterThanOrEqual(0);
    expect(next.cursor).toBeLessThan(rows!);
    expect(next.col).toBeLessThan(cols!);
    screen.resize(cols!, rows!);
    const before = screen.buf.length;
    screen.write(stickyUpdate(next));
    expect([screen.row, screen.col]).toEqual([next.cursor, next.col]);
    expect(screen.buf).toHaveLength(before); // no accidental scrollback from oversized rows
  }
});

test("menu/projects precede help, help precedes questions, and closing leaves no persistent hints", () => {
  const f = frame(80, 24);
  f.question = { text: "Hidden question", options: [], index: 0, count: 1, mode: "answer" };
  expect(plain(liveRows(f).rows)).not.toContain("Hidden question");
  f.projects = { items: [], index: 0, status: "Project panel" };
  expect(plain(liveRows(f).rows)).toContain("Project panel");
  expect(plain(liveRows(f).rows)).not.toContain("help");
  f.menu = { title: "Menu panel", items: ["choice"], index: 0 };
  expect(plain(liveRows(f).rows)).toContain("Menu panel");
  expect(plain(liveRows(f).rows)).not.toContain("Project panel");
  f.menu = null; f.projects = null; f.help = null;
  expect(plain(liveRows(f).rows)).toContain("Hidden question");
  f.question = null;
  expect(plain(liveRows(f).rows)).not.toMatch(/help|esc|ctrl|↑↓/);
});
