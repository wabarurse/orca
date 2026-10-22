import { expect, test } from "bun:test";
import { stickyRows, stickyUpdate, reflowAnchor } from "./sticky";
import { tabRow, chapterRows, headerHeight } from "./chrome";
import { historyRows, lineRows, type Line } from "./lines";
import { captureAnchor, resolveAnchor } from "./anchor";
import { userLines } from "./restore";
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

const plainHistory = (lines: Line[], cols: number) => historyRows(lines, cols).map(Bun.stripANSI);

test("message starts and neutral separators reflow separately in both directions (review reproductions)", () => {
  const lines: Line[] = [{ md: "previous message" }, { md: "record 20: " + "words ".repeat(25) }];
  for (const [from, to, expected] of [[80, 23, 2], [80, 10, 3], [23, 80, 2]]) {
    const before = plainHistory(lines, from!);
    const after = plainHistory(lines, to!);
    expect(before.length).not.toBe(after.length);
    const top = before.findIndex(row => row.startsWith("record 20:"));
    const start = reflowAnchor(lines, from!, to!, top);
    expect(start).toBe(expected!);
    expect(after[start]).toStartWith("record 20:");
    expect(reflowAnchor(lines, from!, to!, top - 1)).toBe(start - 1);
    expect(after[start - 1]).toBe("");
  }
});

test("structured markdown AND user fixtures genuinely wrap; forty-message starts survive repeated resizes", () => {
  for (const make of [(text: string): Line => ({ md: text }), (text: string): Line => userLines(text)[0]!]) {
    const lines = Array.from({ length: 40 }, (_, i) => make(`record ${i}: ` + "words ".repeat(25)));
    const before = plainHistory(lines, 80);
    const narrow = plainHistory(lines, 23);
    expect(before.length).toBeGreaterThan(40);
    expect(narrow.length).toBeGreaterThan(before.length);
    let width = 80;
    let top = before.findIndex(row => row.includes("record 20:"));
    for (const cols of [23, 80, 10, 53, 23, 80]) {
      top = reflowAnchor(lines, width, cols, top);
      expect(top).toBe(historyRows(lines.slice(0, 20), cols).length + 1);
      expect(plainHistory(lines, cols)[top]).toBe(Bun.stripANSI(lineRows(lines[20]!, cols)[0]!));
      width = cols;
    }
  }
});

test("nonuniform multiline markdown anchors source parts and interior code graphemes, not whole-block ratios", () => {
  const code = "code-" + "0123456789".repeat(40);
  const lines: Line[] = [{ md: "previous" }, { md: ["long paragraph ".repeat(30), "short source line", "```ts", "tiny", code, "last", "```", "end"].join("\n") }];
  const before = plainHistory(lines, 80);
  const firstCode = before.findIndex(row => row.startsWith("│ code-"));
  const interior = firstCode + 1; // character 78 of this source line, NOT the next message
  expect(before[interior]).toBe("│ " + code.slice(78, 156));
  const anchor = captureAnchor(lines, 80, interior);
  for (const cols of [23, 10, 120, 40, 23, 80]) {
    const after = plainHistory(lines, cols);
    expect(after.length).not.toBe(plainHistory(lines, cols === 80 ? 23 : 80).length);
    const start = after.findIndex(row => row.startsWith("│ code-"));
    const at = resolveAnchor(lines, cols, anchor);
    const offset = Math.floor(78 / (cols - 2));
    expect(at).toBe(start + offset);
    expect(after[at]).toBe("│ " + code.slice(offset * (cols - 2), (offset + 1) * (cols - 2)));
    const short = before.indexOf("short source line");
    expect(reflowAnchor(lines, 80, cols, short)).toBe(after.findIndex(row => row.startsWith(cols < 16 ? "short" : "short source line")));
  }
  expect(resolveAnchor(lines, 80, anchor)).toBe(interior);
});

test("interior user positions retain grapheme offsets across repeated widths, including wide-cell substitution", () => {
  const lines = userLines("first short line\n" + "界é👩‍💻 abc ".repeat(40));
  const before = plainHistory(lines, 23);
  const anchor = captureAnchor(lines, 23, 4);
  expect(anchor.line).toBe(1);
  expect(anchor.offset).toBeGreaterThan(0);
  for (const cols of [80, 10, 1, 50, 23]) {
    const row = resolveAnchor(lines, cols, anchor);
    const mapped = captureAnchor(lines, cols, row);
    const next = captureAnchor(lines, cols, row + 1);
    expect(mapped.line).toBe(anchor.line);
    expect(mapped.offset).toBeLessThanOrEqual(anchor.offset);
    expect(next.offset).toBeGreaterThan(anchor.offset);
  }
  expect(resolveAnchor(lines, 23, anchor)).toBe(4);
  expect(plainHistory(lines, 80).length).toBeLessThan(before.length);
});

test("anchor traces match actual rows for paragraphs, labels, quotes, lists, blanks and fenced code", () => {
  const body = "some **bold** [link](https://example.test) " + "界é👩‍💻 word ".repeat(10);
  const samples: Line[] = [
    { md: `${body}\nshort\n\n> ${body}\n- ${body}\n# heading\n---\n\`\`\`ts\nshort\n${body}\n\nend\n\`\`\`` },
    { md: body, label: "From worker:" }, { md: `# ${body}`, label: "From worker:" },
    { md: "", label: "From worker:" }, { md: "", block: true, continuation: true },
    { md: `\`\`\`\n${body}\n\`\`\``, block: true },
  ];
  for (const line of samples) for (const cols of [10, 23, 80]) {
    const lines = [{ md: "previous" }, line];
    const rows = plainHistory(lines, cols);
    for (let top = 0; top < rows.length; top++) expect(resolveAnchor(lines, cols, captureAnchor(lines, cols, top))).toBe(top);
  }
});

test("table interiors retain their source block rather than guessing a row across grid/stacked layouts", () => {
  const lines: Line[] = [{ md: "previous" }, { md: "| Key | Value |\n|---|---|\n| a | long value words |\n| b | another |" }];
  const anchor = captureAnchor(lines, 80, 5);
  expect(resolveAnchor(lines, 10, anchor)).toBe(plainHistory(lines, 10).findIndex(row => row.startsWith("Key:")));
});

test("large cached histories read only visible rows on frames and keys, including the transient-tail boundary", () => {
  let reads = 0;
  const history = new Proxy(Array.from({ length: 100_000 }, (_, i) => `saved ${i}`), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const partial = Array.from({ length: 30 }, (_, i) => `partial ${i}`);
  const f = { ...frame(), partial: partial.join("\n"), running: ["running tool"], activity: "working…" };
  for (const start of [0, 50_000, 99_990, 100_001, null]) {
    reads = 0;
    const screen = stickyRows(f, history, chrome, start);
    expect(reads).toBeLessThanOrEqual(screen.bodyHeight);
    expect(screen.maxStart).toBe(history.length + partial.length + 2 - screen.bodyHeight);
    const expected = [...Array.from({ length: history.length }, (_, i) => `saved ${i}`), ...partial, "running tool", "working…"]
      .slice(screen.start, screen.start + screen.bodyHeight);
    expect(screen.rows.slice(chrome.length, chrome.length + screen.bodyHeight)).toEqual(expected);
    // Editing a draft still uses the same viewport-sized slice, not an O(history) copy.
    reads = 0;
    stickyRows({ ...f, input: { ...f.input, text: "draft!", cursor: 6 } }, history, chrome, start);
    expect(reads).toBeLessThanOrEqual(screen.bodyHeight);
  }
});
