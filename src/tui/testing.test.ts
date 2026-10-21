import { describe, expect, test } from "bun:test";
import { FakeScreen } from "./testing";

const screen = (cols: number, rows: number, ...writes: string[]) => { const s = new FakeScreen(cols, rows); for (const w of writes) s.write(w); return s; };

describe("FakeScreen", () => {
  test("LF at the bottom scrolls the top row into the scrollback; CUU stops at the visible top", () => {
    const s = screen(10, 3, "1\r\n2\r\n3\r\n4");
    expect(s.screen()).toEqual(["2", "3", "4"]);
    expect(s.text()).toBe("1\n2\n3\n4");
    s.write("\x1b[9AX");
    expect(s.screen()).toEqual(["2X", "3", "4"]); // clamped at the screen's top, not into the scrollback
  });

  test("autowrap waits for the next character (pending wrap), and CR cancels it", () => {
    const s = screen(3, 4, "abc");
    expect([s.row, s.col]).toEqual([0, 2]);
    s.write("\r\n");
    expect(s.text()).toBe("abc"); // no blank row from the full line
    s.write("defg");
    expect(s.text()).toBe("abc\ndef\ng");
  });

  test("wide characters take two columns and wrap whole", () => {
    const s = screen(5, 3, "ab你好");
    expect(s.text()).toBe("ab你\n好");
    expect([s.row, s.col]).toEqual([1, 2]);
    expect(screen(4, 2, "😀😀x").text()).toBe("😀😀\nx");
  });

  test("H takes row;col, G a column, C and D move within the row", () => {
    const s = screen(10, 4, "\x1b[3;4Hx\x1b[1Gy\x1b[2Cz\x1b[9Dw");
    expect(s.screen()).toEqual(["", "", "w  z", ""]);
    expect(screen(10, 4, "abc\x1b[Hd").screen()[0]).toBe("dbc");
  });

  test("2J clears only the screen, 3J the scrollback; J0/J1 and K0/K1/K2 clear their part", () => {
    const s = screen(10, 2, "old\r\nkeep\r\nnow");
    s.write("\x1b[2J");
    expect(s.text()).toBe("old");
    s.write("\x1b[3J");
    expect(s.text()).toBe("");
    expect(s.clears).toBe(1);
    const t = screen(10, 3, "aaaa\r\nbbbb\r\ncccc\x1b[2;3H\x1b[1J");
    expect(t.screen()).toEqual(["", "   b", "cccc"]);
    expect(screen(10, 3, "aaaa\r\nbbbb\r\ncccc\x1b[2;3H\x1b[J").screen()).toEqual(["aaaa", "bb", ""]);
    expect(screen(10, 1, "abcd\x1b[1;2H\x1b[1K").screen()).toEqual(["  cd"]);
    expect(screen(10, 1, "abcd\x1b[1;2H\x1b[K").screen()).toEqual(["a"]);
    expect(screen(10, 1, "abcd\x1b[2K").screen()).toEqual([""]);
  });

  test("throws on what it does not model, and on a write that leaves sync on or the cursor hidden", () => {
    expect(() => screen(10, 2, "\x1b")).toThrow();
    expect(() => screen(10, 2, "\x1bM")).toThrow();
    expect(() => screen(10, 2, "\x1b[?1049h")).toThrow();
    expect(() => screen(10, 2, "\x1b[5S")).toThrow();
    expect(() => screen(10, 2, "\x1b]0;title\x07")).toThrow();
    expect(() => screen(10, 2, "a\bb")).toThrow();
    expect(() => screen(10, 2, "\x1b[?2026h")).toThrow();
    expect(() => screen(10, 2, "\x1b[?25l")).toThrow();
    expect(screen(10, 2, "\x1b[?2026h\x1b[?25l\x1b[1mx\x1b[0m\x1b]8;;u\x07y\x1b]8;;\x07\x1b[?25h\x1b[?2026l\x1b[?2004h").text()).toBe("xy");
  });

  test("resizing down keeps the cursor's row on screen and cuts wide rows", () => {
    const s = screen(10, 4, "a\r\nb\r\nc\r\nabcdefghij");
    s.resize(5, 2);
    expect(s.screen()).toEqual(["c", "abcde"]);
    expect(s.text()).toBe("a\nb\nc\nabcde");
    expect(s.row).toBe(1);
  });

  test("tracks the SGR background per cell; resets, 49 and other SGR behave as on a real terminal", () => {
    const s = screen(10, 2, "a\x1b[48;5;236mb\x1b[1mc\x1b[0md\x1b[44me\x1b[49mf\x1b[48;2;1;2;3m你\x1b[38;5;0mg\x1b[mh");
    expect(s.text()).toBe("abcdef你gh");
    expect(s.backgrounds()[0]).toEqual(["", "48;5;236", "48;5;236", "", "44", "", "48;2;1;2;3", "48;2;1;2;3", "48;2;1;2;3", ""]);
    expect(screen(4, 1, "\x1b[48:5:236mx").backgrounds()[0]).toEqual(["48:5:236"]);
    expect(() => screen(4, 1, "\x1b[48;5m")).toThrow(); // a cut-off colour
  });

  test("an erase while a background is set throws (a real terminal would fill with it); scrolled and cleared rows keep their cells' backgrounds", () => {
    expect(() => screen(4, 2, "\x1b[41m\x1b[K")).toThrow();
    expect(() => screen(4, 2, "\x1b[41m\x1b[2J")).toThrow();
    const s = screen(4, 2, "\x1b[41mab\x1b[0m\r\nc\r\nd");
    expect(s.backgrounds()).toEqual([["41", "41"], [""], [""]]);
    s.write("\x1b[3J");
    expect(s.backgrounds()).toEqual([[""], [""]]);
  });

  test("answers an OSC 11 query only when given a background, like a terminal with or without it", () => {
    const silent = screen(4, 1, "\x1b]11;?\x1b\\");
    expect([silent.queries, silent.replies]).toEqual([1, []]);
    const s = new FakeScreen(4, 1);
    s.background = "rgb:ffff/ffff/ffff";
    s.write("\x1b]11;?\x07");
    expect(s.replies).toEqual(["\x1b]11;rgb:ffff/ffff/ffff\x1b\\"]);
    expect(s.text()).toBe("");
  });
});

test("SGR dim, bold and foreground survive soft wraps but not the block reset", async () => {
  const { commit } = await import("./render");
  const s = new FakeScreen(4, 8);
  s.write(commit(["\x1b[2mgraygray\x1b[31;1mredred\x1b[0m", "normal"], 4));
  const attrs = s.attributes();
  expect(attrs[1]!.every((c) => c.dim && !c.bold)).toBe(true);
  expect(attrs[2]!.every((c) => c.dim && c.bold && c.foreground === "31")).toBe(true);
  expect(attrs[3]![0]).toEqual({ dim: true, bold: true, foreground: "31" });
  expect(attrs[4]!.every((c) => !c.dim && !c.bold && c.foreground === "")).toBe(true);
});
