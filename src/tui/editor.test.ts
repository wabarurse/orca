import { describe, expect, test } from "bun:test";
import * as ed from "./editor";

const at = (text: string, cursor = text.length) => ({ text, cursor });
const rows = (l: ed.Layout) => l.rows.map((r) => r.text);

describe("layout", () => {
  test("wraps by width and finds the cursor's row and column", () => {
    const l = ed.layout(at("abcdefghij", 6), 4);
    expect(rows(l)).toEqual(["abcd", "efgh", "ij"]);
    expect([l.row, l.col]).toEqual([1, 2]);
  });

  test("newlines start rows; empty lines are rows too", () => {
    const l = ed.layout(at("ab\n\ncd"), 4);
    expect(rows(l)).toEqual(["ab", "", "cd"]);
    expect([l.row, l.col]).toEqual([2, 2]);
    expect(ed.layout(at("ab\n\ncd", 3), 4)).toMatchObject({ row: 1, col: 0 });
  });

  test("a full row is followed by an empty one for the cursor", () => {
    const l = ed.layout(at("abcd"), 4);
    expect(rows(l)).toEqual(["abcd", ""]);
    expect([l.row, l.col]).toEqual([1, 0]);
    expect(ed.layout(at("abcd", 3), 4)).toMatchObject({ row: 0, col: 3 });
    expect(rows(ed.layout(at("abcd\nx"), 4))).toEqual(["abcd", "", "x"]);
  });

  test("wide characters take two columns", () => {
    const l = ed.layout(at("你好世界ab"), 6);
    expect(rows(l)).toEqual(["你好世", "界ab"]);
    expect([l.row, l.col]).toEqual([1, 4]);
    expect(ed.layout(at("你好世界ab", 2), 6)).toMatchObject({ row: 0, col: 4 });
    // A wide character that does not fit wraps whole, leaving a gap.
    expect(rows(ed.layout(at("abc你"), 4))).toEqual(["abc", "你"]);
    expect(rows(ed.layout(at("😀😀😀"), 4))).toEqual(["😀😀", "😀"]);
  });
});

describe("vertical", () => {
  test("moves between wrapped rows keeping the column, null at the edges", () => {
    const s = at("abcdefghij", 6); // row 1, col 2
    expect(ed.vertical(s, 4, -1)).toEqual(at("abcdefghij", 2));
    expect(ed.vertical(s, 4, 1)).toEqual(at("abcdefghij", 10)); // clamped to the short last row
    expect(ed.vertical(at("abcdefghij", 2), 4, -1)).toBeNull();
    expect(ed.vertical(at("abcdefghij"), 4, 1)).toBeNull();
  });

  test("matches display columns across wide characters", () => {
    // Row 0 "你好世" (6 cols), row 1 "界ab"; from the end (col 4) up lands after 好.
    expect(ed.vertical(at("你好世界ab"), 6, -1)).toEqual(at("你好世界ab", 2));
    expect(ed.vertical(at("你好世界ab", 5), 6, -1)).toEqual(at("你好世界ab", 1)); // col 3 is inside 好
    // Row 0 "abc" soft-wraps before 你; from col 3 on row 1 up stays on row 0 rather than at row 1's start.
    expect(ed.vertical(at("abc你ab", 5), 4, -1)!.cursor).toBe(2);
  });

  test("moves across logical lines", () => {
    expect(ed.vertical(at("hello\nhi"), 10, -1)).toEqual(at("hello\nhi", 2));
    expect(ed.vertical(at("hi\nhello", 1), 10, 1)).toEqual(at("hi\nhello", 4));
  });
});

describe("graphemes", () => {
  test("left, right and backspace never split a cluster", () => {
    const thumb = "a👍🏽b";
    expect(ed.left(at(thumb, 5)).cursor).toBe(1);
    expect(ed.right(at(thumb, 1)).cursor).toBe(5);
    expect(ed.backspace(at(thumb, 5))).toEqual(at("ab", 1));
    const e = "cafe\u0301!";
    expect(ed.backspace(at(e, 5))).toEqual(at("caf!", 3));
    expect(ed.deleteForward(at(e, 3))).toEqual(at("caf!", 3));
  });

  test("words include astral letters and combining marks", () => {
    expect(ed.deleteWordBack(at("hi 𝒜𝒷𝒸"))).toEqual(at("hi "));
    expect(ed.wordForward("cafe\u0301 x", 0)).toBe(5);
  });
});

describe("scrollWindow", () => {
  test("moves only when the cursor leaves the window", () => {
    expect(ed.scrollWindow(0, 1, 5, 3)).toBe(0);
    expect(ed.scrollWindow(0, 3, 5, 3)).toBe(1);
    expect(ed.scrollWindow(2, 3, 5, 3)).toBe(2);
    expect(ed.scrollWindow(2, 1, 5, 3)).toBe(1);
    expect(ed.scrollWindow(9, 4, 5, 3)).toBe(2); // clamped to the end
  });
});

describe("words", () => {
  test("alt+backspace deletes the previous word, skipping punctuation and spaces", () => {
    expect(ed.deleteWordBack(at("git commit -m"))).toEqual(at("git commit -"));
    expect(ed.deleteWordBack(at("foo bar  "))).toEqual(at("foo "));
    expect(ed.deleteWordBack(at("path/to/file"))).toEqual(at("path/to/"));
    expect(ed.deleteWordBack(at("one two", 3))).toEqual(at(" two", 0));
    expect(ed.deleteWordBack(at("", 0))).toEqual(at("", 0));
  });

  test("alt+d deletes the next word", () => {
    expect(ed.deleteWordForward(at("foo bar baz", 3))).toEqual(at("foo baz", 3));
  });

  test("word moves", () => {
    expect(ed.wordLeft(at("foo bar")).cursor).toBe(4);
    expect(ed.wordRight(at("foo bar", 0)).cursor).toBe(3);
    expect(ed.wordRight(at("foo bar", 3)).cursor).toBe(7);
  });

  test("ctrl+w deletes back to whitespace", () => {
    expect(ed.rubout(at("a path/to/file"))).toEqual(at("a "));
  });
});

describe("editing", () => {
  test("insert, backspace and delete around the cursor", () => {
    expect(ed.insert(at("ac", 1), "b")).toEqual(at("abc", 2));
    expect(ed.backspace(at("abc", 2))).toEqual(at("ac", 1));
    expect(ed.backspace(at("a😀"))).toEqual(at("a"));
    expect(ed.deleteForward(at("abc", 0))).toEqual(at("bc", 0));
  });

  test("home, end and kills work on the current line", () => {
    const s = at("one\ntwo", 5);
    expect(ed.home(s).cursor).toBe(4);
    expect(ed.end(s).cursor).toBe(7);
    expect(ed.killToStart(s)).toEqual(at("one\nwo", 4));
    expect(ed.killToEnd(s)).toEqual(at("one\nt", 5));
  });
});
