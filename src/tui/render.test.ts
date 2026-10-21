import { describe, expect, test } from "bun:test";
import { append, commit, erase, expandTabs, inputArea, live, liveRows, menuRows, NOTHING, projectRows, reprint, visibleLength, windowStart, wrap, type Frame, type ProjectList } from "./render";
import { FakeScreen } from "./testing";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");
/** The live region's rows as text. */
const rows = (f: Frame) => liveRows(f).rows.map(strip);
/** Write escape codes to a fake terminal of the given size and read it back. */
const show = (size: { cols: number; rows: number }, ...writes: string[]) => { const s = new FakeScreen(size.cols, size.rows); for (const w of writes) s.write(w); return s; };

function frame(over: Partial<Frame> = {}): Frame {
  return { cols: 20, rows: 7, input: { prompt: "> ", text: "hi", cursor: 2 }, menu: null, ...over };
}

describe("wrap", () => {
  test("splits by visible width and keeps escapes intact", () => {
    expect(wrap("abcdef", 4)).toEqual(["abcd\x1b[0m", "ef"]);
    const pieces = wrap("\x1b[1mabcdef\x1b[0m", 4);
    expect(pieces.map(visibleLength)).toEqual([4, 2]);
  });
});

describe("wrap widths", () => {
  test("wide characters count two columns and wrap whole", () => {
    expect(wrap("你好世界ab", 6).map(strip)).toEqual(["你好世", "界ab"]);
    expect(wrap("ab😀c", 3).map(strip)).toEqual(["ab", "😀c"]);
    expect(visibleLength("\x1b[2m你\x1b[0m")).toBe(2);
  });
});

describe("tabs and escapes", () => {
  test("tabs expand to the next 8-column stop before wrapping", () => {
    expect(expandTabs("a\tb")).toBe("a       b");
    expect(expandTabs("\x1b[2mab\x1b[0m\tc")).toBe("\x1b[2mab\x1b[0m      c");
    expect(expandTabs("你\tx")).toBe("你      x");
    expect(wrap("a\tbcdefghij", 10).map(strip)).toEqual(["a       bc", "defghij"]);
  });

  test("scrollback lines with tabs wrap instead of overflowing", () => {
    expect(show({ cols: 10, rows: 5 }, commit(["\tabcdef"], 10)).text()).toBe("        ab\ncdef");
  });

  test("wrap skips colon CSI params and OSC hyperlinks like stringWidth does", () => {
    const link = "\x1b]8;;https://x.y\x07abcdef\x1b]8;;\x07";
    expect(wrap(link, 4).map(visibleLength)).toEqual([4, 2]);
    expect(wrap("\x1b]8;;u\x1b\\abcdef", 4).map(visibleLength)).toEqual([4, 2]);
    expect(wrap("\x1b[38:2::1:2:3mabcdef", 4).map(visibleLength)).toEqual([4, 2]);
  });
});

describe("commit", () => {
  test("wraps finished lines to the width, splits newlines, and ends each row with CRLF", () => {
    const out = commit(["abcdefgh", "x\ny"], 5);
    expect(out.split("\r\n").map(strip)).toEqual(["abcde", "fgh", "x", "y", ""]);
    const s = show({ cols: 5, rows: 10 }, out);
    expect(s.text()).toBe("abcde\nfgh\nx\ny");
    expect([s.row, s.col]).toEqual([4, 0]); // a fresh line below
  });
});

describe("live", () => {
  test("rows top to bottom: partial line, menu, status, input; cursor in the input", () => {
    const f = frame({ partial: "streaming", status: "⠋ thinking… 3s · one", menu: { title: "pick", items: ["x", "y"], index: 1 } });
    expect(rows(f)).toEqual(["streaming", "pick", "  x", "❯ y", "⠋ thinking… 3s · one", "> hi"]);
    const { text, shown } = live(f);
    expect(shown).toEqual({ height: 6, cursor: 5 });
    const s = show(f, text);
    expect(s.text()).toBe("streaming\npick\n  x\n❯ y\n⠋ thinking… 3s · one\n> hi");
    expect([s.row, s.col]).toEqual([5, 4]); // after "> hi"
  });

  test("redraws by moving up exactly to the previous first row and clearing to the end", () => {
    const first = live(frame({ rows: 12, status: "s", input: { prompt: "> ", text: "one\ntwo\nthree", cursor: 3 } }));
    expect(first.shown).toEqual({ height: 4, cursor: 1 }); // status, then the cursor on "> one"
    const next = live(frame({ status: "s2" }), first.shown);
    expect(next.text).toContain("\r\x1b[1A\x1b[J"); // up by the cursor's row, then clear down
    expect(erase(first.shown)).toBe("\r\x1b[1A\x1b[J");
    expect(erase({ height: 3, cursor: 2 })).toBe("\r\x1b[2A\x1b[J");
    expect(erase(NOTHING)).toBe("");
    const s = show({ cols: 20, rows: 12 }, "above\r\n", first.text, next.text);
    expect(s.text()).toBe("above\ns2\n> hi");
    expect([s.row, s.col]).toEqual([2, 4]);
  });

  test("committing erases the live region, writes the lines above, and draws it again", () => {
    const f = frame({ status: "busy" });
    const a = live(f);
    const b = append(["> hello", "reply"], f, a.shown);
    const c = append(["more"], f, b.shown);
    const s = show(f, "$ parallels start\r\n", a.text, b.text, c.text);
    expect(s.text()).toBe("$ parallels start\n> hello\nreply\nmore\nbusy\n> hi");
    expect(c.text).not.toContain("\x1b[2J");
  });

  test("reprint clears the screen and the scrollback, then writes history and the live region", () => {
    const { text } = reprint(["one", "two"], frame());
    expect(text).toContain("\x1b[2J\x1b[3J\x1b[H");
    const s = show(frame(), "old stuff\r\n", text);
    expect(s.text()).toBe("one\ntwo\n> hi");
    expect(s.clears).toBe(1);
  });

  test("a long partial line wraps and shows its end when the screen is short", () => {
    expect(rows(frame({ cols: 5, partial: "abcdefghijkl" }))).toEqual(["abcde", "fghij", "kl", "> hi"]);
    expect(rows(frame({ cols: 5, rows: 3, partial: "abcdefghijkl" }))).toEqual(["fghij", "kl", "> hi"]);
  });

  test("wrapped input grows, and multi-line input indents rows under the prompt", () => {
    const f = frame({ rows: 9, input: { prompt: "> ", text: "0123456789abcdefghij", cursor: 12 } });
    expect(rows(f)).toEqual(["> 0123456789abcdefgh", "  ij"]);
    expect(liveRows(f)).toMatchObject({ cursor: 0, col: 14 });
    const m = frame({ rows: 9, input: { prompt: "> ", text: "one\ntwo", cursor: 5 } });
    expect(rows(m)).toEqual(["> one", "  two"]);
    expect(liveRows(m)).toMatchObject({ cursor: 1, col: 3 });
  });

  test("the input is capped at a third of the screen and scrolls to the cursor", () => {
    const text = "1\n2\n3\n4\n5";
    const end = frame({ rows: 9, input: { prompt: "> ", text, cursor: text.length } });
    expect(rows(end)).toEqual(["  3", "  4", "  5"]);
    expect(liveRows(end)).toMatchObject({ cursor: 2, col: 3 });
    const start = frame({ rows: 9, status: "s", input: { prompt: "> ", text, cursor: 0 } });
    expect(rows(start)).toEqual(["s", "> 1", "  2", "  3"]);
    expect(liveRows(start)).toMatchObject({ cursor: 1, col: 2 });
  });

  test("the input window keeps its top until the cursor leaves it", () => {
    const text = "1\n2\n3\n4\n5";
    const area = (cursor: number, top?: number) => inputArea({ prompt: "> ", text, cursor, top }, 20, 9);
    expect(area(0).top).toBe(0);
    expect(area(2, 0).top).toBe(0); // row 1: still in view
    expect(area(4, 0).top).toBe(0); // row 2: last row in view
    expect(area(6, 0).top).toBe(1); // row 3: scrolls by one
    expect(area(8, 1).top).toBe(2);
    expect(area(4, 2).top).toBe(2); // back up to row 2: no scroll
    expect(area(8).top).toBe(2); // no previous top: show the end
  });

  test("wide characters in the input place the cursor by display width", () => {
    const f = frame({ rows: 9, cols: 8, input: { prompt: "> ", text: "你好世界ab", cursor: 6 } });
    expect(rows(f)).toEqual(["> 你好世", "  界ab"]);
    expect(liveRows(f)).toMatchObject({ cursor: 1, col: 6 });
  });

  test("a long menu keeps the selection in view and fits the screen", () => {
    const items = Array.from({ length: 10 }, (_, i) => `m${i}`);
    expect(menuRows({ title: "pick", items, index: 8 }, 4).map(strip)).toEqual(["pick", "  m6", "  m7", "❯ m8"]);
    const r = rows(frame({ rows: 6, status: "s", menu: { title: "pick", items, index: 0 } }));
    expect(r.length).toBeLessThanOrEqual(6);
    expect(r.slice(-2)).toEqual(["s", "> hi"]);
  });

  test("a long menu or status row is cut to the width with … and its style closed", () => {
    const f = frame({ cols: 40, rows: 9, status: "z".repeat(50), menu: { title: "pick", items: [`\x1b[2m${"y".repeat(60)}`], index: 0 } });
    const r = liveRows(f).rows;
    expect(visibleLength(r[1]!)).toBe(40);
    expect(r[1]!.endsWith("…\x1b[0m")).toBe(true);
    expect(strip(r[2]!)).toBe("z".repeat(39) + "…");
  });

  const projects = (over: Partial<ProjectList> = {}): ProjectList => ({
    items: [
      { name: "orch-p1n0", label: "pinned", pinned: true, open: false, active: false, busy: false }, // rows show the label, not the id
      { name: "one", label: "one", pinned: false, open: true, active: true, busy: false },
      { name: "two", label: "two", pinned: false, open: true, active: false, busy: true },
    ],
    index: 1, status: "", ...over,
  });

  test("the project list sits above the status line and a multi-row input", () => {
    const f = frame({ cols: 60, rows: 12, partial: "half", status: "⠋ thinking… 1s", projects: projects(), input: { prompt: "> ", text: "one\ntwo\nthree", cursor: 13 } });
    expect(rows(f)).toEqual(["half", "projects", "  *  pinned", "❯  ● one", "   ○ two ·", "↑↓ Enter opens   p pins   d deletes   Esc closes", "⠋ thinking… 1s", "> one", "  two", "  three"]);
    expect(liveRows(f)).toMatchObject({ cursor: 9, col: 7 });
  });

  test("project rows scroll to keep the selection in view, with the status under the list", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `id${i}`, label: `p${i}`, pinned: false, open: false, active: false, busy: false }));
    const out = projectRows({ items: many, index: 8, status: "delete p8? y/n" }, 6).map(strip);
    expect(out).toEqual(["projects", "     p6", "     p7", "❯    p8", "delete p8? y/n", "↑↓ Enter opens   p pins   d deletes   Esc closes"]);
    expect(projectRows({ items: [], index: 0, status: "" }, 5).map(strip)).toEqual(["projects", "  none yet", "↑↓ Enter opens   p pins   d deletes   Esc closes"]);
    expect(windowStart(10, 0, 3)).toBe(0);
    expect(windowStart(10, 9, 3)).toBe(7);
    expect(windowStart(2, 1, 5)).toBe(0);
  });

  test("on a short terminal the status and hint stay ahead of the list", () => {
    expect(projectRows(projects({ status: "delete one? y/n" }), 2).map(strip)).toEqual(["delete one? y/n", "↑↓ Enter opens   p pins   d deletes   Esc closes"]);
    expect(projectRows(projects({ status: "delete one? y/n" }), 1).map(strip)).toEqual(["delete one? y/n"]);
    expect(rows(frame({ cols: 60, rows: 4, projects: projects({ status: "delete one? y/n" }) }))).toEqual(["delete one? y/n", "↑↓ Enter opens   p pins   d deletes   Esc closes", "> hi"]);
  });
});

describe("on a faithful terminal", () => {
  const term = (cols: number, rows: number) => new FakeScreen(cols, rows);

  test("committed lines of exactly the width, and one past it", () => {
    const s = term(5, 6);
    s.write(commit(["abcde", "abcdef", "x"], 5));
    expect(s.text()).toBe("abcde\nabcde\nf\nx"); // no blank row after a full one
    expect([s.row, s.col]).toEqual([4, 0]);
  });

  test("CJK and emoji lines wrap by display width", () => {
    const s = term(5, 6);
    s.write(commit(["你好世界ab", "ab😀cd😀"], 5));
    expect(s.text()).toBe("你好\n世界a\nb\nab😀c\nd😀");
  });

  test("a 3-row wrapped input is drawn with the cursor in it, then erased", () => {
    const f = frame({ cols: 10, rows: 12, status: "s", input: { prompt: "> ", text: "0123456789abcdefghij", cursor: 10 } });
    const s = term(10, 12);
    s.write("above\r\n");
    const a = live(f);
    s.write(a.text);
    expect(s.screen().slice(0, 5)).toEqual(["above", "s", "> 01234567", "  89abcdef", "  ghij"]);
    expect([s.row, s.col]).toEqual([3, 4]); // after "89"
    s.write(erase(a.shown) + "\x1b[?25h");
    expect(s.text()).toBe("above");
    expect([s.row, s.col]).toEqual([1, 0]);
  });

  test("on rows=6 a menu, a partial line and a multi-row input are capped to fit, and redraw cleanly", () => {
    const items = Array.from({ length: 8 }, (_, i) => `m${i}`);
    const f = frame({ cols: 10, rows: 6, partial: "streaming text", status: "s", menu: { title: "pick", items, index: 5 }, input: { prompt: "> ", text: "a\nb\nc", cursor: 5 } });
    const { rows: r } = liveRows(f);
    expect(r.length).toBeLessThanOrEqual(6);
    const s = term(10, 6);
    s.write("1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n");
    const a = live(f);
    s.write(a.text);
    expect(s.screen()).toEqual(r.map(strip).map((x) => x.trimEnd()));
    expect(s.screen().slice(-3)).toEqual(["s", "  b", "  c"]);
    expect(s.screen().join("\n")).toContain("❯ m5");
    // Redrawn smaller: the old region is gone, the scrollback intact.
    s.write(live(frame({ cols: 10, rows: 6 }), a.shown).text);
    expect(s.text()).toBe("1\n2\n3\n4\n5\n6\n> hi");
  });

  test("a partial line over two rows, then committed", () => {
    const s = term(10, 8);
    const a = live(frame({ cols: 10, rows: 8, partial: "0123456789abc" }));
    s.write(a.text);
    expect(s.text()).toBe("0123456789\nabc\n> hi");
    s.write(append(["0123456789abcdef"], frame({ cols: 10, rows: 8 }), a.shown).text);
    expect(s.text()).toBe("0123456789\nabcdef\n> hi");
    expect([s.row, s.col]).toEqual([2, 4]);
  });
});
