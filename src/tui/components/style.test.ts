import { afterEach, describe, expect, test } from "bun:test";
import { commit, live, liveRows, type Frame } from "../footer/render";
import { userLines } from "../conversation/restore";
import { lineRows } from "../conversation/lines";
import { baseText, fillRow, nearest256, pickFill, pickText, setBaseText, setUserFill, shade, textRow, useTerminalBackground, userFill } from "./style";
import { FakeScreen } from "./testing";

const BG = "\x1b[48;5;236m";
/** The background a FakeScreen cell gets from BG. */
const CELL = "48;5;236";
afterEach(() => { setUserFill(null); setBaseText(null); });

const frame = (over: Partial<Frame> = {}): Frame => ({ cols: 20, rows: 12, input: { prompt: "> ", text: "hi", cursor: 2 }, menu: null, status: "s", ...over });
const draw = (f: Frame) => { const s = new FakeScreen(f.cols, f.rows); s.write(live(f).text); return s; };
/** The visible screen's backgrounds, one string per row: "#" a cell on BG, "." one without. */
const marks = (s: FakeScreen) => s.backgrounds().slice(s.top).map((r) => Array.from({ length: s.cols }, (_, c) => (r[c] === CELL ? "#" : r[c] ? "?" : ".")).join(""));
const full = (cols: number) => "#".repeat(cols);
const none = (cols: number) => ".".repeat(cols);
/** History lines committed to a fresh screen. */
const committed = (lines: Parameters<typeof lineRows>[0][], cols: number, rows = 10) => {
  const s = new FakeScreen(cols, rows);
  s.write(commit(lines.flatMap((l) => lineRows(l, cols)), cols));
  return s;
};

describe("input area", () => {
  test("the input and counts are framed by the box, never shaded; styling never changes the cursor", () => {
    const f = frame();
    setUserFill(null);
    const plain = draw(f);
    setUserFill(BG);
    const s = draw(f);
    // The count row sits inside the box, in place of its bottom edge.
    expect(s.screen().slice(0, 4)).toEqual(["┌──────────────────┐", "│ > hi             │", "│ s                │", ""]);
    expect(marks(s).slice(0, 3)).toEqual([none(20), none(20), none(20)]);
    expect([s.row, s.col]).toEqual([plain.row, plain.col]);
    expect([s.row, s.col]).toEqual([1, 6]);
  });

  test("a wrapped multi-row input: every row inside the box, unshaded, the cursor on its row and column", () => {
    setUserFill(BG);
    const text = "0123456789abcdefghij\nsecond";
    const s = draw(frame({ input: { prompt: "> ", text, cursor: 12 } }));
    expect(s.screen().slice(0, 6)).toEqual(["┌──────────────────┐", "│ > 0123456789abcd │", "│   efghij         │", "│   second         │", "│ s                │", ""]);
    expect(marks(s).slice(0, 5)).toEqual(Array(5).fill(none(20)));
    expect([s.row, s.col]).toEqual([1, 16]); // after "│ > 0123456789ab"
    const end = draw(frame({ input: { prompt: "> ", text, cursor: text.length } }));
    expect([end.row, end.col]).toEqual([3, 10]);
  });

  test("input and status stay unshaded on a short screen", () => {
    setUserFill(BG);
    const s = draw(frame({ rows: 3 }));
    expect(s.screen()).toEqual(["> hi", "s", ""]);
    expect(marks(s).slice(0, 2)).toEqual([none(20), none(20)]);
    expect([s.row, s.col]).toEqual([0, 4]);
  });

  test("CJK input pads by display width", () => {
    setUserFill(BG);
    const s = draw(frame({ cols: 11, input: { prompt: "> ", text: "你好世界", cursor: 4 } }));
    expect(s.screen().slice(0, 4)).toEqual(["┌─────────┐", "│ > 你好  │", "│   世界  │", "│ s       │"]);
    expect(marks(s).slice(0, 4)).toEqual(Array(4).fill(none(11)));
  });

  test("a dim prompt and a narrow width stay unshaded", () => {
    setUserFill(BG);
    const s = draw(frame({ cols: 4, input: { prompt: "\x1b[2ma>\x1b[0m ", text: "xyz", cursor: 3 } }));
    expect(s.screen().slice(0, 2)).toEqual(["a…xy", "  z"]);
    expect(marks(s).slice(0, 3)).toEqual(Array(3).fill(none(4)));
  });

  test("NO_COLOR: no background, box and prompt remain legible", () => {
    setUserFill(pickFill({ NO_COLOR: "1" }));
    expect(userFill()).toBeNull();
    const s = draw(frame());
    expect(s.screen().slice(0, 4)).toEqual(["┌──────────────────┐", "│ > hi             │", "│ s                │", ""]);
    expect(marks(s).every((r) => !r.includes("#"))).toBe(true);
    expect(liveRows(frame()).cursor).toBe(1);
  });
});

describe("user messages", () => {
  test("a wrapped user message is filled on every row, full width; other lines are not", () => {
    setUserFill(BG);
    const s = committed(["before", ...userLines("abcdefghijkl\nmn"), "after"], 8);
    expect(s.text()).toBe("before\n> abcdef\nghijkl\n  mn\nafter");
    expect(marks(s).slice(0, 5)).toEqual([".".repeat(8), full(8), full(8), full(8), ".".repeat(8)]);
  });

  test("a reset inside the line (the bold marker, markdown, dim) does not drop the background", () => {
    setUserFill(BG);
    const s = committed(userLines("a \x1b[2mdim\x1b[0m and \x1b[1;4mmore\x1b[m end"), 30);
    expect(s.text()).toBe("> a dim and more end");
    expect(marks(s)[0]).toBe(full(30));
    // a colour argument of 0 is not a reset: 38;5;0 keeps the fill without re-applying it
    expect(fillRow("\x1b[38;5;0mx", 3, BG)).toBe(`${BG}\x1b[38;5;0mx  \x1b[0m`);
    expect(fillRow("a\x1b[0mb\x1b[49mc", 4, BG)).toBe(`${BG}a\x1b[0m${BG}b\x1b[49m${BG}c \x1b[0m`);
  });

  test("CJK and emoji pad by display width; a narrow width wraps them whole", () => {
    setUserFill(BG);
    const s = committed(userLines("你好世界😀"), 7);
    expect(s.text()).toBe("> 你好\n世界😀");
    expect(marks(s).slice(0, 2)).toEqual([full(7), full(7)]); // 6 columns of wide characters, then a pad space on the fill
    expect(s.buf[1]!.join("")).toBe("世界😀 ");
    const narrow = committed(userLines("abc"), 2);
    expect(narrow.text()).toBe(">\nab\nc"); // trailing spaces trimmed
    expect(marks(narrow).slice(0, 3)).toEqual([full(2), full(2), full(2)]);
  });

  test("a restored page and a resize lay the message out again at the new width", () => {
    setUserFill(BG);
    const lines = userLines("one two three");
    expect(lineRows(lines[0]!, 10).length).toBe(2);
    expect(lineRows(lines[0]!, 40).length).toBe(1);
    const wide = committed(lines, 40);
    expect(marks(wide)[0]).toBe(full(40));
  });

  test("NO_COLOR keeps the \"> \" marker and draws no background", () => {
    setUserFill(pickFill({ NO_COLOR: "1" }));
    const s = committed(userLines("hello"), 10);
    expect(s.text()).toBe("> hello");
    expect(marks(s)[0]).toBe(".".repeat(10));
  });
});

describe("colour choice", () => {
  test("blends the terminal's background 10% towards white (dark) or black (light)", () => {
    expect(shade({ r: 0, g: 0, b: 0 })).toEqual({ r: 26, g: 26, b: 26 });
    expect(shade({ r: 255, g: 255, b: 255 })).toEqual({ r: 230, g: 230, b: 230 });
    expect(pickFill({ COLORTERM: "truecolor" }, { r: 30, g: 30, b: 46 })).toBe("\x1b[48;2;53;53;67m");
    expect(pickFill({}, { r: 0, g: 0, b: 0 })).toBe(`\x1b[48;5;${nearest256({ r: 26, g: 26, b: 26 })}m`);
    expect(nearest256({ r: 26, g: 26, b: 26 })).toBe(234);
    expect(nearest256({ r: 230, g: 230, b: 230 })).toBe(254);
  });

  test("without an answer: COLORFGBG, else a grey with its own light text; NO_COLOR and TERM=dumb turn it off", () => {
    expect(pickFill({ COLORFGBG: "15;0" })).toBe("\x1b[48;5;234m");
    expect(pickFill({ COLORFGBG: "0;default;15" })).toBe("\x1b[48;5;254m");
    expect(pickFill({})).toBe("\x1b[48;5;236;38;5;252m");
    expect(pickFill({ COLORFGBG: "nonsense" })).toBe("\x1b[48;5;236;38;5;252m");
    expect(pickFill({ NO_COLOR: "1", COLORTERM: "truecolor" }, { r: 0, g: 0, b: 0 })).toBeNull();
    expect(pickFill({ NO_COLOR: "" })).not.toBeNull(); // no-color.org: set and not empty
    expect(pickFill({ TERM: "dumb" })).toBeNull();
    useTerminalBackground({ r: 255, g: 255, b: 255 }, { COLORTERM: "24bit" });
    expect(userFill()).toBe("\x1b[48;2;230;230;230m");
  });
});

test("ordinary text is pure white on a background known to be dark, and the terminal's own colour otherwise", () => {
  const dark = { r: 30, g: 30, b: 30 }, light = { r: 250, g: 250, b: 250 };
  expect(pickText({ COLORTERM: "truecolor" }, dark)).toBe("\x1b[38;2;255;255;255m");
  expect(pickText({}, dark)).toBe("\x1b[38;5;231m");
  expect(pickText({ COLORFGBG: "15;0" })).toBe("\x1b[38;5;231m");
  expect(pickText({ COLORTERM: "truecolor" }, light)).toBeNull();
  expect(pickText({ COLORTERM: "truecolor" })).toBeNull(); // unknown background: never white on white
  expect(pickText({ NO_COLOR: "1" }, dark)).toBeNull();
  const before = baseText();
  try { useTerminalBackground(dark, { COLORTERM: "truecolor" }); expect(baseText()).toBe("\x1b[38;2;255;255;255m"); }
  finally { setBaseText(before); setUserFill(pickFill({ NO_COLOR: "1" })); }
});

test("a row in the text colour returns to it after every reset inside, and keeps other colours", () => {
  const w = "\x1b[38;5;231m";
  expect(textRow("plain \x1b[2mdim\x1b[0m then \x1b[1;32mgreen\x1b[0m", w)).toBe(`${w}plain \x1b[2mdim\x1b[0m${w} then \x1b[1;32mgreen\x1b[0m${w}`);
  expect(textRow("\x1b[31mred\x1b[39m back", w)).toBe(`${w}\x1b[31mred\x1b[39m${w} back`);
});
