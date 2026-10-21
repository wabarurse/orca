import { describe, expect, test } from "bun:test";
import { keyReader, parseKeys, takeKeys, type Key } from "./keys";

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

  test("alt+backspace in every encoding", () => {
    const want = [{ name: "backspace", alt: true }];
    expect(parseKeys("\x1b\x7f")).toEqual(want);
    expect(parseKeys("\x1b[127;3u")).toEqual(want);
    expect(parseKeys("\x1b[27;3;127~")).toEqual(want);
  });

  test("word movement and deletion chords", () => {
    expect(parseKeys("\x1b[1;3D\x1b[1;3C")).toEqual([{ name: "left", alt: true }, { name: "right", alt: true }]);
    expect(parseKeys("\x1b\x1b[D")).toEqual([{ name: "left", alt: true }]);
    expect(parseKeys("\x1bb\x1bf\x1bd")).toEqual([{ name: "b", alt: true }, { name: "f", alt: true }, { name: "d", alt: true }]);
    expect(parseKeys("\x1b[100;3u")).toEqual([{ name: "d", alt: true }]);
    expect(parseKeys("\x17")).toEqual([{ name: "w", ctrl: true }]);
  });

  test("shift+enter and alt+enter", () => {
    expect(parseKeys("\x1b[13;2u")).toEqual([{ name: "enter", shift: true }]);
    expect(parseKeys("\x1b[27;2;13~")).toEqual([{ name: "enter", shift: true }]);
    expect(parseKeys("\x1b\r")).toEqual([{ name: "enter", alt: true }]);
  });

  test("bracketed paste is one key with normalised newlines", () => {
    expect(parseKeys("a\x1b[200~one\r\ntwo\rthree\x1b[201~b")).toEqual([
      { name: "char", text: "a" }, { name: "paste", text: "one\ntwo\nthree" }, { name: "char", text: "b" },
    ]);
  });

  test("takeKeys holds an unfinished paste for the next chunk", () => {
    const first = takeKeys("x\x1b[200~line one\r");
    expect(first.keys).toEqual([{ name: "char", text: "x" }]);
    const second = takeKeys(first.rest + "line two\x1b[201~");
    expect(second).toEqual({ keys: [{ name: "paste", text: "line one\nline two" }], rest: "" });
  });

  test("a read that ends inside the paste start marker waits for the rest", () => {
    const first = takeKeys("ab\x1b[20");
    expect(first).toEqual({ keys: [{ name: "char", text: "ab" }], rest: "\x1b[20" });
    const second = takeKeys(first.rest + "0~x\ry\x1b[201~");
    expect(second).toEqual({ keys: [{ name: "paste", text: "x\ny" }], rest: "" });
    // Any unfinished CSI waits too; a lone Esc does not.
    expect(takeKeys("\x1b[1;").rest).toBe("\x1b[1;");
    expect(takeKeys("\x1b")).toEqual({ keys: [{ name: "escape" }], rest: "" });
  });

  test("an unterminated paste still lets Ctrl+C through", () => {
    expect(takeKeys("\x1b[200~stuck\x03")).toEqual({ keys: [{ name: "paste", text: "stuck" }, { name: "c", ctrl: true }], rest: "" });
  });

  test("keyReader flushes a held tail after the idle timeout", async () => {
    const got: Key[] = [];
    const feed = keyReader((k) => got.push(k), 20);
    feed("\x1b[200~never\rends");
    expect(got).toEqual([]);
    await Bun.sleep(50);
    expect(got).toEqual([{ name: "paste", text: "never\nends" }]);
    feed("a\x1b[20");
    feed("0~b\x1b[201~");
    expect(got.slice(1)).toEqual([{ name: "char", text: "a" }, { name: "paste", text: "b" }]);
  });

  test("Esc then an arrow: one read or two, the Esc survives; only Left/Right become Alt", () => {
    expect(parseKeys("\x1b\x1b[A")).toEqual([{ name: "escape" }, { name: "up" }]);
    expect([...parseKeys("\x1b"), ...parseKeys("\x1b[A")]).toEqual([{ name: "escape" }, { name: "up" }]);
    expect(parseKeys("\x1b\x1b[B")).toEqual([{ name: "escape" }, { name: "down" }]);
    expect(parseKeys("\x1b\x1b[5~")).toEqual([{ name: "escape" }, { name: "pageup" }]);
    expect(parseKeys("\x1b\x1b[C")).toEqual([{ name: "right", alt: true }]);
  });

  test("a mixed buffer keeps order", () => {
    expect(parseKeys("ab\x1b[A\rc")).toEqual([{ name: "char", text: "ab" }, { name: "up" }, { name: "enter" }, { name: "char", text: "c" }]);
  });
});
