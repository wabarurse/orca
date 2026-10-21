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
});
