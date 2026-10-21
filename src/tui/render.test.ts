import { describe, expect, test } from "bun:test";
import { render, visibleLength, wrap, type Frame } from "./render";

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

  test("no pages leaves the tab bar empty", () => {
    expect(rows(render(frame({ tabs: [] })))[0]).toBe("");
  });
});
