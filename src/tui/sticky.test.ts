import { expect, test } from "bun:test";
import { stickyRows, stickyUpdate, reflowAnchor } from "./sticky";
import { tabRow, chapterRows, headerHeight } from "./chrome";
import { historyRows, type Line } from "./lines";
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
  expect(terminal.screen().slice(-4)).toEqual(["┌" + "─".repeat(78) + "┐", "│> draft" + " ".repeat(71) + "│", "└" + "─".repeat(78) + "┘", "2 agents running"]);
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
  expect(terminal.screen().slice(-4)).toEqual(["┌" + "─".repeat(78) + "┐", "│> draft" + " ".repeat(71) + "│", "└" + "─".repeat(78) + "┘", "2 agents running"]);
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
  expect(Bun.stripANSI(tabRow(pages, 2, 16))).toContain("[gamma]");
  expect(Bun.stringWidth(tabRow(pages, 2, 16))).toBeLessThanOrEqual(16);
});

test("SGR wheel events scroll without inserting terminal reports into the draft", () => {
  expect(parseKeys("\x1b[<64;12;8M\x1b[<65;12;8M")).toEqual([{ name: "wheelup" }, { name: "wheeldown" }]);
  expect(parseKeys("\x1b[<0;12;8M\x1b[<0;12;8m")).toEqual([]);
});

test("selected activity and tools live only at the conversation tail, never in either pinned bar", () => {
  const f = { ...frame(), status: "2 agents running │ 0 messages queued │ 1 question", partial: "partial reply", running: ["⏺ Bash(wait)"], activity: "⠋ working…" };
  const header = chapterRows({ tabs: [{ name: "orch-live" }], active: 0, model: "model · effort high · fast on", directory: "/repo", remote: "host/repo" }, 80, headerHeight(24));
  const s = new FakeScreen(80, 24);
  const first = stickyRows(f, history, header);
  s.write(stickyUpdate(first));
  const at = s.screen().indexOf("⠋ working…");
  expect(s.screen().slice(at - 2, at + 2)).toEqual(["partial reply", "⏺ Bash(wait)", "⠋ working…", "┌" + "─".repeat(78) + "┐"]);
  expect(s.backgrounds()[at]!.some(Boolean)).toBe(false);
  const read = stickyRows(f, history, header, 3);
  s.write(stickyUpdate(read, first));
  expect(s.text()).not.toMatch(/working|Bash|partial/);
  const tick = stickyRows({ ...f, activity: "⠙ working…" }, [...history, "finished output"], header, 3);
  expect(stickyUpdate(tick, read)).toBe("");
  const completed = stickyRows({ ...f, partial: "", running: [], activity: undefined }, [...history, "finished output"], header);
  s.write(stickyUpdate(completed, tick));
  expect(s.text()).not.toMatch(/working|Bash|partial/);
  expect(s.text()).toContain("finished output");
  expect(s.top).toBe(0);
  expect(history).toHaveLength(100);
});

test("native sticky geometry is cell-correct through narrow/tiny resizes, panels, and multiline cursors", () => {
  const text = "a界é\nhello 👩‍💻\nlast line";
  const chapter = { tabs: Array.from({ length: 20 }, (_, i) => ({ name: `orch-${i}` })), active: 19, model: "model · effort high · fast on", directory: "/long/".repeat(100), remote: "host/repo" };
  for (const cols of [1, 2, 3, 4, 5, 6, 7, 12, 24, 80]) for (const rows of [1, 2, 3, 4, 7, 8, 9, 12, 24]) {
    const header = chapterRows(chapter, cols, headerHeight(rows));
    const s = new FakeScreen(cols, rows);
    let previous: ReturnType<typeof stickyRows> | undefined;
    for (const cursor of [0, 4, 7, text.length, 0]) {
      const f = { ...frame(cols, rows), input: { prompt: "worker-long-界 > ", text, cursor }, status: "2 agents running │ 1 message queued │ 3 questions", activity: "⠋ thinking…", question: { text: "Which option?", options: ["one", "two"], index: 0, count: 1, mode: "pick" as const } };
      const next = stickyRows(f, ["hello"], header);
      expect(next.rows).toHaveLength(rows);
      expect(next.rows.every(row => Bun.stringWidth(row) <= cols)).toBe(true);
      expect(next.cursor).toBeGreaterThanOrEqual(0);
      expect(next.cursor).toBeLessThan(rows);
      expect(next.col).toBeGreaterThanOrEqual(0);
      expect(next.col).toBeLessThan(cols);
      s.write(stickyUpdate(next, previous));
      expect([s.row, s.col]).toEqual([next.cursor, next.col]);
      expect(s.top).toBe(0);
      previous = next;
    }
  }
});

test("reflow anchors the current logical block rather than a stale rendered row number", () => {
  const lines: Line[] = Array.from({ length: 40 }, (_, i) => `record ${i}: ` + "words ".repeat(25));
  const before = historyRows(lines, 80);
  const top = before.findIndex(row => row.startsWith("record 20:"));
  const anchored = reflowAnchor(lines, 80, 23, top);
  expect(historyRows(lines, 23)[anchored]).toStartWith("record 20:");
  expect(reflowAnchor(lines, 23, 80, anchored)).toBe(top);
  // Within a wrapped record, keep a proportional offset rather than jumping to its start.
  expect(reflowAnchor(lines, 80, 23, top + 1)).toBeGreaterThan(anchored);
});
