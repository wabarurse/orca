import { afterEach, expect, test } from "bun:test";
import { append, commit, headerRow, live, liveRows, type Frame } from "./render";
import { historyRows, type Line } from "./lines";
import { userLines } from "./restore";
import { MarkdownStream } from "./mdstream";
import { FakeScreen } from "./testing";
import { pickFill, setUserFill } from "./style";

const bg = "\x1b[48;5;236m";
afterEach(() => setUserFill(null));
const frame = (cols = 40, rows = 12): Frame => ({ cols, rows, bottomBar: true, status: "2 agents running · 1 question · Ctrl+Q to view", input: { prompt: "> ", text: "hello\n你好", cursor: 8 }, menu: { title: "models", items: ["one", "two"], index: 0 } });

test("bottom bar input precedes counts and modal; cursor and backgrounds survive append and resize", () => {
  setUserFill(bg);
  const f = frame();
  const r = liveRows(f);
  expect(r.rows.map(Bun.stripANSI).map((s) => s.trimEnd())).toEqual(["> hello", "  你好", "2 agents running · 1 question · Ctrl+Q …", "models", "❯ one", "  two"]);
  expect([r.cursor, r.col]).toEqual([1, 6]);
  const screen = new FakeScreen(f.cols, f.rows);
  const first = live(f);
  screen.write(first.text);
  expect([screen.row, screen.col]).toEqual([1, 6]);
  expect(screen.backgrounds().slice(0, 6).every((row) => row.length === 40 && row.every((b) => b === "48;5;236"))).toBe(true);
  const next = append(["reply"], f, first.shown);
  screen.write(next.text);
  expect(screen.text().startsWith("reply\n> hello")).toBe(true);
  expect([screen.row, screen.col]).toEqual([2, 6]);
  screen.resize(12, 4);
  screen.write("\x1b[2J\x1b[H" + live(frame(12, 4)).text);
  expect(screen.row).toBeLessThan(4);
  expect(screen.col).toBeLessThan(12);
});

test("short and narrow composers never spill or lose cursor; NO_COLOR gives no bands", () => {
  for (const cols of [2, 4, 8]) for (const rows of [1, 2, 3]) {
    setUserFill(bg);
    const f = frame(cols, rows);
    const drawn = liveRows(f);
    expect(drawn.rows.length).toBeLessThanOrEqual(rows);
    expect(drawn.rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
    const s = new FakeScreen(cols, rows);
    s.write(live(f).text);
    expect(s.col).toBe(drawn.col);
  }
  setUserFill(pickFill({ NO_COLOR: "1" }));
  expect(liveRows(frame()).rows.join("")).not.toContain("48;");
});

test("header is committed once above chat, not pinned in the live region", () => {
  const f = frame();
  const s = new FakeScreen(40, 12);
  s.write(commit([headerRow("project · model · directory · remote", 40)], 40));
  const a = live(f);
  s.write(a.text);
  s.write(append(["response"], f, a.shown).text);
  expect(s.text().split("project · model")).toHaveLength(2);
  expect(s.backgrounds()[0]!.every(Boolean)).toBe(true);
});

test("logical block separators are neutral, tools stay paired, lists and wrapped rows stay together", () => {
  setUserFill(bg);
  const lines: Line[] = [...userLines("hello long message\ncontinuation"), { md: "reply", block: true }, { md: "", block: true }, { md: "- a", block: true }, { md: "- b", block: true }, { tool: "Bash(ls)", summary: "2 lines", failed: false }, { tool: "Bash(sleep)", summary: "interrupted", failed: true }];
  const full = historyRows(lines, 12);
  const split = [...historyRows(lines.slice(0, 4), 12), ...historyRows(lines.slice(4), 12, lines[3])];
  expect(split).toEqual(full);
  const s = new FakeScreen(12, 30);
  s.write(commit(full, 12));
  expect(s.text()).toContain("reply\n\n- a\n- b\n\n⏺ Bash(ls)\n  ⎿  2 lines\n\n⏺ Bash(slee…\n  ⎿  interr…");
  for (const [i, row] of s.buf.entries()) if (!row.join("").trim()) expect(s.backgrounds()[i]!.some(Boolean)).toBe(false);
});

test("stream chunk boundaries do not change spacing", () => {
  const text = "First paragraph.\n\n- one\n- two\n\nLast.\n";
  function rows(chunks: string[]) {
    const md = new MarkdownStream();
    const lines: Line[] = [];
    for (const chunk of chunks) lines.push(...md.feed(chunk).map((md) => ({ md, block: true })));
    lines.push(...md.flush().map((md) => ({ md, block: true })));
    return historyRows(lines, 10);
  }
  expect(rows([...text])).toEqual(rows([text]));
});
