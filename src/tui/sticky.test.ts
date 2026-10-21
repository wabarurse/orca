import { expect, test } from "bun:test";
import { stickyRows, stickyUpdate, tabs } from "./sticky";
import { type Frame } from "./render";
import { FakeScreen } from "./testing";
import { parseKeys } from "./keys";

const frame = (cols = 80, rows = 24): Frame => ({ cols, rows, input: { prompt: "> ", text: "draft", cursor: 5 }, status: "2 agents running", menu: null });
const chrome = ["[alpha] beta", "alpha · model · effort high · fast on", "/working/directory", "github.com/example/repo"];
const history = Array.from({ length: 100 }, (_, i) => `message ${i}`);

test("both bars stay at screen edges while streaming and scrolling; only changed rows repaint", () => {
  const f = frame(), terminal = new FakeScreen(f.cols, f.rows);
  const first = stickyRows(f, history, chrome);
  terminal.write(stickyUpdate(first));
  expect(terminal.screen().slice(0, 4)).toEqual(chrome);
  expect(terminal.screen().slice(-2)).toEqual(["> draft", "2 agents running"]);
  expect(terminal.screen()).toContain("message 99");
  const scrolled = stickyRows(f, history, chrome, 10);
  const update = stickyUpdate(scrolled, first);
  expect(update).not.toContain("[alpha]");
  expect(update).not.toContain("> draft");
  terminal.write(update);
  expect(terminal.screen()[4]).toBe("message 10");
  const appended = stickyRows({ ...f, partial: "streaming…" }, [...history, "new output"], chrome, 10);
  expect(stickyUpdate(appended, scrolled)).toBe("");
  expect(terminal.screen().slice(0, 4)).toEqual(chrome);
  expect(terminal.screen().slice(-2)).toEqual(["> draft", "2 agents running"]);
});

test("resize, wrapped input and menus keep the cursor in the bottom bar without stale rows", () => {
  for (const cols of [1, 2, 12, 80]) for (const rows of [1, 2, 3, 6, 24]) {
    const f = { ...frame(cols, rows), input: { prompt: "> ", text: "你好\nsecond\nthird", cursor: 15 }, menu: { title: "choose", items: ["one", "two"], index: 1 } };
    const next = stickyRows(f, history, chrome);
    expect(next.rows).toHaveLength(rows);
    expect(next.rows.every(row => Bun.stringWidth(row) <= cols)).toBe(true);
    expect(next.cursor).toBeGreaterThanOrEqual(0);
    expect(next.cursor).toBeLessThan(rows);
    const terminal = new FakeScreen(cols, rows);
    terminal.write(stickyUpdate(next));
    expect([terminal.row, terminal.col]).toEqual([next.cursor, next.col]);
    const closed = stickyRows(frame(cols, rows), [], chrome);
    terminal.write(stickyUpdate(closed, next));
    expect(terminal.screen()).not.toContain("choose");
  }
});

test("selected tabs remain visible in a narrow terminal, with names treated as display text", () => {
  const pages = [{ name: "alpha", busy: false }, { name: "beta", busy: true }, { name: "gamma", busy: false }];
  expect(Bun.stripANSI(tabs(pages, 2, 16))).toContain("[gamma]");
  expect(Bun.stringWidth(tabs(pages, 2, 16))).toBeLessThanOrEqual(16);
});

test("SGR wheel events scroll without inserting terminal reports into the draft", () => {
  expect(parseKeys("\x1b[<64;12;8M\x1b[<65;12;8M")).toEqual([{ name: "wheelup" }, { name: "wheeldown" }]);
  expect(parseKeys("\x1b[<0;12;8M\x1b[<0;12;8m")).toEqual([]);
});
