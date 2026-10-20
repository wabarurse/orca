import { describe, expect, test } from "bun:test";
import { parseKeys } from "./keys";

describe("parseKeys", () => {
  test("printable runs are batched", () => {
    expect(parseKeys("hello")).toEqual([{ name: "char", text: "hello" }]);
  });

  test("control bytes become ctrl chords and named keys", () => {
    expect(parseKeys("\x0e")).toEqual([{ name: "n", ctrl: true }]);
    expect(parseKeys("\x03")).toEqual([{ name: "c", ctrl: true }]);
    expect(parseKeys("\r")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\x7f")).toEqual([{ name: "backspace" }]);
    expect(parseKeys("\t")).toEqual([{ name: "tab" }]);
  });

  test("legacy arrows, home/end and page keys", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }]);
    expect(parseKeys("\x1bOH\x1b[F\x1b[5~\x1b[6~\x1b[3~")).toEqual([{ name: "home" }, { name: "end" }, { name: "pageup" }, { name: "pagedown" }, { name: "delete" }]);
  });

  test("a lone escape, and Alt as ESC prefix", () => {
    expect(parseKeys("\x1b")).toEqual([{ name: "escape" }]);
    expect(parseKeys("\x1b,")).toEqual([{ name: ",", alt: true }]);
    expect(parseKeys("\x1b.")).toEqual([{ name: ".", alt: true }]);
  });

  test("kitty CSI u encodes Ctrl+, and Ctrl+.", () => {
    expect(parseKeys("\x1b[44;5u")).toEqual([{ name: ",", ctrl: true }]);
    expect(parseKeys("\x1b[46;5u")).toEqual([{ name: ".", ctrl: true }]);
    expect(parseKeys("\x1b[110;5u")).toEqual([{ name: "n", ctrl: true }]);
    expect(parseKeys("\x1b[13u")).toEqual([{ name: "enter" }]);
    expect(parseKeys("\x1b[27u")).toEqual([{ name: "escape" }]);
    expect(parseKeys("\x1b[97u")).toEqual([{ name: "char", text: "a" }]);
  });

  test("xterm modifyOtherKeys encodes Ctrl+, too", () => {
    expect(parseKeys("\x1b[27;5;44~")).toEqual([{ name: ",", ctrl: true }]);
  });

  test("a mixed buffer keeps order", () => {
    expect(parseKeys("ab\x1b[A\rc")).toEqual([{ name: "char", text: "ab" }, { name: "up" }, { name: "enter" }, { name: "char", text: "c" }]);
  });
});
