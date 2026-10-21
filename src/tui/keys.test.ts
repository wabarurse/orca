import { describe, expect, test } from "bun:test";
import { keyReader, parseKeys, type Key, type SetTimer } from "./keys";

/** A keyReader on a manual timer: fire() runs the pending idle flush. */
function reader() {
  const got: Key[] = [];
  let pending: (() => void) | null = null;
  const setTimer: SetTimer = (fn) => { pending = fn; return () => { pending = null; }; };
  const r = keyReader((k) => got.push(k), 300, setTimer);
  return {
    got, feed: r.feed, close: r.close,
    fire() { const fn = pending; pending = null; fn?.(); },
    get timers() { return pending ? 1 : 0; },
  };
}

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

  test("a paste split across reads waits for its end marker", () => {
    const r = reader();
    r.feed("x\x1b[200~line one\r");
    expect(r.got).toEqual([{ name: "char", text: "x" }]);
    r.feed("\nline two\x1b[20");
    r.feed("1~y");
    expect(r.got).toEqual([{ name: "char", text: "x" }, { name: "paste", text: "line one\nline two" }, { name: "char", text: "y" }]);
  });

  test("a read that ends inside the paste start marker waits for the rest", () => {
    const r = reader();
    r.feed("ab\x1b[20");
    expect(r.got).toEqual([{ name: "char", text: "ab" }]);
    r.feed("0~x\ry\x1b[201~");
    expect(r.got).toEqual([{ name: "char", text: "ab" }, { name: "paste", text: "x\ny" }]);
  });

  test("unfinished escapes wait for the next read or the timeout; a lone Esc does not", () => {
    const r = reader();
    r.feed("\x1b[1;");
    r.feed("3D");
    expect(r.got).toEqual([{ name: "left", alt: true }]);
    r.feed("\x1bO");
    expect(r.got.length).toBe(1);
    r.feed("A");
    expect(r.got[1]).toEqual({ name: "up" });
    r.feed("\x1b");
    expect(r.got[2]).toEqual({ name: "escape" });
    r.feed("\x1b[");
    expect(r.got.length).toBe(3);
    r.fire();
    expect(r.got[3]).toEqual({ name: "escape" });
  });

  test("a stalled paste stays paste text after the timeout: no Enter", () => {
    const r = reader();
    r.feed("\x1b[200~part one\r");
    r.fire();
    r.feed("part two\rmore\x1b[201~");
    expect(r.got.some((k) => k.name === "enter")).toBe(false);
    expect(r.got.map((k) => k.text).join("")).toBe("part one\npart two\nmore");
    expect(r.got.every((k) => k.name === "paste")).toBe(true);
  });

  test("a stalled paste flushes what arrived, then keeps reading paste text", () => {
    const r = reader();
    r.feed("\x1b[200~part one ");
    r.fire();
    expect(r.got).toEqual([{ name: "paste", text: "part one " }]);
    r.feed("part two\rmore\x1b[201~\r");
    expect(r.got).toEqual([{ name: "paste", text: "part one " }, { name: "paste", text: "part two\nmore" }, { name: "enter" }]);
  });

  test("Ctrl+C ends an unterminated paste", () => {
    const r = reader();
    r.feed("\x1b[200~stuck");
    r.feed("\x03");
    expect(r.got).toEqual([{ name: "paste", text: "stuck" }, { name: "c", ctrl: true }]);
    expect(parseKeys("\x1b[200~stuck\x03")).toEqual([{ name: "paste", text: "stuck" }, { name: "c", ctrl: true }]);
  });

  test("close drops what is held and stops the timer", () => {
    const r = reader();
    r.feed("\x1b[200~half");
    r.close();
    expect(r.timers).toBe(0);
    r.feed("a");
    expect(r.got).toEqual([{ name: "char", text: "a" }]);
  });

  test("the real timer flushes after idleMs", async () => {
    const got: Key[] = [];
    const r = keyReader((k) => got.push(k), 10);
    r.feed("\x1b[");
    await Bun.sleep(100);
    expect(got).toEqual([{ name: "escape" }]);
    r.close();
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

/** A keyReader that expects a terminal reply while `expect.on`, on a manual timer. */
function replyReader() {
  const expect = { on: true };
  const got: Key[] = [];
  let pending: (() => void) | null = null;
  const r = keyReader((k) => got.push(k), 300, (fn) => { pending = fn; return () => { pending = null; }; }, () => expect.on);
  return { got, expect, feed: r.feed, fire() { const fn = pending; pending = null; fn?.(); }, get timers() { return pending ? 1 : 0; } };
}

const REPLY = { name: "osc", text: "11;rgb:0000/0000/0000" };

describe("OSC replies", () => {
  test("a terminal's OSC reply is an osc key, never typed text; Alt+] still reads as Alt+]", () => {
    expect(parseKeys("\x1b]11;rgb:0000/0000/0000\x1b\\x")).toEqual([REPLY, { name: "char", text: "x" }]);
    expect(parseKeys("\x1b]11;rgb:ffff/ffff/ffff\x07")).toEqual([{ name: "osc", text: "11;rgb:ffff/ffff/ffff" }]);
    expect(parseKeys("\x1b]11;rgb:ff")).toEqual([{ name: "osc", text: "11;rgb:ff" }]); // cut off: dropped as a reply, not typed
    expect(parseKeys("\x1b]")).toEqual([{ name: "]", alt: true }]);
  });

  test("while a reply is expected, one split anywhere (even right after ESC) waits for its end", () => {
    for (const cut of [1, 2, 4, 20, 23, 24]) {
      const r = replyReader();
      const reply = "\x1b]11;rgb:0000/0000/0000\x1b\\";
      r.feed(reply.slice(0, cut));
      expect(r.got).toEqual([]);
      r.feed(`${reply.slice(cut)}hi`);
      expect(r.got).toEqual([REPLY, { name: "char", text: "hi" }]);
      expect(r.timers).toBe(0);
    }
    const r = replyReader();
    r.feed("\x1b");
    r.feed("]11;rgb:0000/0000/0000\x1b\\");
    expect(r.got).toEqual([REPLY]); // no Esc, no "]11;…" typed
  });

  test("Esc and Alt+] arrive at once when no reply is expected; held ones still arrive after the idle timeout", () => {
    const r = replyReader();
    r.expect.on = false;
    r.feed("\x1b");
    r.feed("\x1b]");
    expect(r.got).toEqual([{ name: "escape" }, { name: "]", alt: true }]);
    expect(r.timers).toBe(0);
    const w = replyReader();
    w.feed("\x1b");
    expect(w.got).toEqual([]);
    w.fire();
    expect(w.got).toEqual([{ name: "escape" }]);
    w.feed("\x1b]");
    w.fire();
    expect(w.got).toEqual([{ name: "escape" }, { name: "]", alt: true }]);
  });

  test("a reply still unterminated at the idle timeout is dropped, and its rest swallowed up to BEL or ST for one more idle period", () => {
    const r = replyReader();
    r.feed("\x1b]11;rgb:00");
    r.fire();
    expect(r.got).toEqual([]);
    r.feed("00/0000/00");
    r.feed("00\x1b");
    r.feed("\\ok");
    expect(r.got).toEqual([{ name: "char", text: "ok" }]);
    const late = replyReader();
    late.feed("\x1b]11;rgb:00");
    late.fire();
    late.fire(); // the extra idle period passes: typing is typing again
    late.feed("abc");
    expect(late.got).toEqual([{ name: "char", text: "abc" }]);
    const quit = replyReader();
    quit.feed("\x1b]11;rgb:00");
    quit.fire();
    quit.feed("00\x03");
    expect(quit.got).toEqual([{ name: "c", ctrl: true }]); // Ctrl+C still quits
  });
});
