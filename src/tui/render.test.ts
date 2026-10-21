import { describe, expect, test } from "bun:test";
import { inputArea, render, visibleLength, wrap, type Frame } from "./render";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, "");
const rows = (s: string) => s.split("\x1b[2K").slice(1).map((r) => strip(r).replace(/^.*?H/, ""));

function frame(over: Partial<Frame> = {}): Frame {
  return {
    cols: 20, rows: 7, header: "~/p/one · gh/x", tabs: [{ title: "one", active: true, busy: false }, { title: "two", active: false, busy: true }],
    lines: ["a", "b", "c"], scroll: 0, input: { prompt: "> ", text: "hi", cursor: 2 }, menu: null, ...over,
  };
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

describe("render", () => {
  test("lays out tabs, header, body and input over the whole screen", () => {
    const out = render(frame());
    const r = rows(out);
    expect(r.length).toBe(7);
    expect(r[0]).toBe(" one   two · ");
    expect(r[1]).toBe("~/p/one · gh/x");
    expect(r.slice(2, 6)).toEqual(["", "a", "b", "c"]);
    expect(r[6]).toBe("> hi");
    expect(out.endsWith("\x1b[7;5H\x1b[?25h")).toBe(true); // cursor after "> hi"
  });

  test("a long header is cut with an ellipsis, not wrapped", () => {
    const r = rows(render(frame({ header: "0123456789012345678901234567890" })));
    expect(r[1]).toBe("0123456789012345678…");
    expect(r.length).toBe(7);
  });

  test("the body shows the newest lines, scrolled up on request", () => {
    expect(rows(render(frame({ lines: ["1", "2", "3", "4", "5"] }))).slice(2, 6)).toEqual(["2", "3", "4", "5"]);
    expect(rows(render(frame({ lines: ["1", "2", "3", "4", "5"], scroll: 1 }))).slice(2, 6)).toEqual(["1", "2", "3", "4"]);
  });

  test("a menu sits at the bottom of the body", () => {
    const r = rows(render(frame({ menu: { title: "pick", items: ["x", "y"], index: 1 } })));
    expect(r.slice(2, 6)).toEqual(["", "pick", "  x", "❯ y"]);
  });

  test("a status line sits between the body and the input; busy tabs show the spinner frame", () => {
    const r = rows(render(frame({ status: "⠋ thinking… 3s", tabs: [{ title: "one", active: true, busy: true, spinner: "⠙" }] })));
    expect(r.length).toBe(7);
    expect(r[0]).toBe(" one ⠙ ");
    expect(r.slice(2, 5)).toEqual(["a", "b", "c"]);
    expect(r[5]).toBe("⠋ thinking… 3s");
    expect(r[6]).toBe("> hi");
    expect(rows(render(frame({ status: null }))).slice(2, 6)).toEqual(["", "a", "b", "c"]);
  });

  test("wrapped input grows upward, taking rows from the body", () => {
    const out = render(frame({ rows: 9, input: { prompt: "> ", text: "0123456789abcdefghij", cursor: 12 } }));
    const r = rows(out);
    expect(r.length).toBe(9);
    expect(r.slice(2, 7)).toEqual(["", "", "a", "b", "c"]);
    expect(r.slice(7)).toEqual(["> 0123456789abcdefgh", "  ij"]);
    expect(out.endsWith("\x1b[8;15H\x1b[?25h")).toBe(true); // row 8, after "> 0123456789ab"
  });

  test("multi-line input indents rows under the prompt and places the cursor", () => {
    const out = render(frame({ rows: 9, input: { prompt: "> ", text: "one\ntwo", cursor: 5 } }));
    expect(rows(out).slice(7)).toEqual(["> one", "  two"]);
    expect(out.endsWith("\x1b[9;4H\x1b[?25h")).toBe(true);
  });

  test("the input is capped at a third of the screen and scrolls to the cursor", () => {
    const text = "1\n2\n3\n4\n5";
    const end = render(frame({ rows: 9, input: { prompt: "> ", text, cursor: text.length } }));
    expect(rows(end).slice(6)).toEqual(["  3", "  4", "  5"]);
    expect(end.endsWith("\x1b[9;4H\x1b[?25h")).toBe(true);
    const start = render(frame({ rows: 9, input: { prompt: "> ", text, cursor: 0 } }));
    expect(rows(start).slice(6)).toEqual(["> 1", "  2", "  3"]);
    expect(start.endsWith("\x1b[7;3H\x1b[?25h")).toBe(true);
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
    const out = render(frame({ rows: 9, cols: 8, input: { prompt: "> ", text: "你好世界ab", cursor: 6 } }));
    expect(rows(out).slice(7)).toEqual(["> 你好世", "  界ab"]);
    expect(out.endsWith("\x1b[9;7H\x1b[?25h")).toBe(true);
  });

  test("no pages leaves the tab bar empty", () => {
    expect(rows(render(frame({ tabs: [] })))[0]).toBe("");
  });
});
