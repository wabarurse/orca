import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../app";
import { helpLines } from "./help";
import { helpPanel, liveRows, type Frame } from "./render";
import { chatScreen } from "../screen";
import { setUserFill } from "../components/style";
import { testTerminal } from "../../test/otui-term";

// Visual review: __snapshots__/help.test.ts.snap contains the 80x24 and 40x24
// pinned screens, full content at both widths, and the scrolled diagnostic tail.
// Verify with `bun test src/tui/footer/help.test.ts`; use -u only for intentional edits.
// Pure fixture: no run/openPage, disk reads, tmux, login, or model calls.
const term = testTerminal(80, 24);
const commands = new App({ term, openOrchestrator: async () => { throw new Error("render-only fixture"); } }).commands;
const plain = (rows: string[]) => rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
const frame = (cols: number, rows: number, top = 0): Frame => ({
  cols, rows, menu: null,
  input: { prompt: "> ", text: "draft 界", cursor: 5 },
  status: "2 agents running │ 1 task │ inbox 1",
  help: { lines: helpLines(commands, false, cols), top },
});
/** The footer region the screen shows under the conversation: the boxed composer and its counts, then the help panel. */
const footer = (f: Frame) => chatScreen(f, [], null);
afterEach(() => setUserFill(null));

describe("help appearance fixtures", () => {
  for (const cols of [80, 40]) {
    test(`${cols}x24: help starts below the boxed composer and its counts, leaving room for the conversation`, () => {
      const f = frame(cols, 24);
      const screen = footer(f);
      expect(plain(screen.footer)).toMatchSnapshot();
      const rows = screen.footer.map(Bun.stripANSI);
      expect(rows.findIndex(row => row.startsWith("help"))).toBeGreaterThan(rows.findIndex(row => row.startsWith("┌")));
      expect(rows.length).toBeLessThanOrEqual(24 - 3);
      expect(rows[screen.cursor!.row]).toContain("draft 界");
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
    expect(plain(footer(f).footer)).toMatchSnapshot();
    const panel = helpPanel({ ...f, rows: 19 });
    expect(panel.top).toBe(panel.maxTop);
    expect(plain(panel.rows)).toContain("/compact");
    expect(plain(panel.rows)).toContain("esc close");
  });
});

test("help wraps without overflow and the footer and its cursor fit tiny terminals and repeated resizing", () => {
  setUserFill("\x1b[48;5;236m");
  for (const [cols, rows] of [[80, 24], [40, 24], [20, 12], [12, 8], [8, 4], [4, 3], [2, 2], [1, 1], [120, 40]]) {
    const f = frame(cols!, rows!);
    expect(f.help!.lines.every(row => Bun.stringWidth(row) <= cols!)).toBe(true);
    const next = chatScreen(f, [], null);
    expect(next.footer.length).toBeLessThanOrEqual(rows!);
    expect(next.footer.every(row => Bun.stringWidth(row) <= cols!)).toBe(true);
    expect(next.cursor!.row).toBeGreaterThanOrEqual(0);
    expect(next.cursor!.row).toBeLessThan(Math.max(1, next.footer.length));
    expect(next.cursor!.col).toBeLessThan(cols!);
  }
});

test("a menu precedes help; closing never reveals the removed question footer", () => {
  const f = frame(80, 24);
  f.question = { text: "Hidden question", options: [], index: 0, count: 1, mode: "answer" };
  expect(plain(liveRows(f).rows)).not.toContain("Hidden question");
  f.menu = { title: "Menu panel", items: ["choice"], index: 0 };
  expect(plain(liveRows(f).rows)).toContain("Menu panel");
  expect(plain(liveRows(f).rows)).not.toContain("help ·");
  f.menu = null; f.help = null;
  expect(plain(liveRows(f).rows)).not.toContain("Hidden question");
  f.question = null;
  expect(plain(liveRows(f).rows)).not.toMatch(/help|esc|ctrl|↑↓/);
});

test("help lists the page chords and has no Vim modes", () => {
  const text = plain(helpLines(commands, false, 100));
  for (const label of ["ctrl+h / ctrl+l", "ctrl+a/t/q/g/p/b", "a/A · u · r", "keyboard · editing"]) expect(text).toContain(label);
  expect(text).not.toMatch(/\[INSERT\]|Insert mode|Shift\+[A-Z]|abandon|ctrl\+z/);
});
