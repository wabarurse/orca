import { describe, expect, test } from "bun:test";
import { keyReader, parseKeys, type Key, type SetTimer, ESC_DELAY_MS } from "./keys";

/** A keyReader on a manual timer: fire() runs the pending idle flush. */
function reader() {
  const got: Key[] = [];
  let pending: (() => void) | null = null;
  let delay = 0;
  const setTimer: SetTimer = (fn, ms) => { delay = ms; pending = fn; return () => { pending = null; }; };
  const r = keyReader((k) => got.push(k), 300, setTimer);
  return {
    got, feed: r.feed, close: r.close,
    fire() { const fn = pending; pending = null; fn?.(); },
    get timers() { return pending ? 1 : 0; },
    get delay() { return delay; },
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

  test("unfinished escapes wait; a lone Esc has a short bounded disambiguation window", () => {
    const r = reader();
    r.feed("\x1b[1;");
    r.feed("3D");
    expect(r.got).toEqual([{ name: "left", alt: true }]);
    r.feed("\x1bO");
    expect(r.got.length).toBe(1);
    r.feed("A");
    expect(r.got[1]).toEqual({ name: "up" });
    r.feed("\x1b");
    expect(r.got).toHaveLength(2);
    expect(r.delay).toBe(ESC_DELAY_MS);
    r.fire();
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

  test("Esc has a short wait outside the reply window; Alt+] stays immediate", () => {
    const r = replyReader();
    r.expect.on = false;
    r.feed("\x1b");
    r.fire();
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

/** Ignore read-dependent batching of adjacent text events, but no other differences. */
function normalized(keys: Key[]): Key[] {
  const out: Key[] = [];
  for (const k of keys) {
    const last = out.at(-1);
    if (k.name === "char" && last?.name === "char") last.text += k.text!;
    else out.push({ ...k });
  }
  return out;
}
const sgr = (button: number, final = "M") => `\x1b[<${button};10;20${final}`;
const x10 = (button: number, x = 42, y = 42) => Buffer.from([27, 91, 77, button + 32, x, y]);

describe("mouse input framing (not native gestures)", () => {
  test("SGR and raw legacy X10 vertical wheels, every split including immediately after ESC", () => {
    for (const mod of [0, 4, 8, 16, 28]) for (const [button, name] of [[64, "wheelup"], [65, "wheeldown"]] as const) {
      for (const packet of [Buffer.from(sgr(button + mod)), x10(button + mod), x10(button + mod, 194, 160), x10(button + mod, 255, 254)]) {
        for (let cut = 1; cut < packet.length; cut++) {
          const r = reader();
          r.feed(packet.subarray(0, cut));
          expect(r.got).toEqual([]);
          r.feed(packet.subarray(cut));
          expect(r.got).toEqual([{ name }]);
          expect(r.timers).toBe(0);
        }
        const r = reader();
        for (const byte of packet) r.feed(Uint8Array.of(byte));
        expect(r.got).toEqual([{ name }]);
      }
    }
    expect(parseKeys("\x1b[M`**")).toEqual([{ name: "wheelup" }]);
  });

  test("horizontal, release, motion, clicks, extended and malformed reports are consumed, never vertical scroll or text", () => {
    const ignored = [
      ...[0, 1, 2, 3, 32, 66, 67, 96, 97, 128, 192, 193, 256, 320].flatMap(button => [Buffer.from(sgr(button)), ...(button <= 223 ? [x10(button)] : [])]),
      Buffer.from(sgr(64, "m")), Buffer.from(sgr(65, "m")),
      ...["<64", "<64;10", "<64;1;2;3", "<64;;2", "<64;0;2", "<64;-1;2", "<64;1.5;2", "<64;1;0", "<64;9007199254740992;2", "<9007199254741056;1;2"].map(p => Buffer.from(`\x1b[${p}M`)),
      x10(64, 32), Buffer.from("\x1b[?9999h"), Buffer.from("\x1b[<64;1;2Z"),
    ];
    for (const packet of ignored) for (let cut = 1; cut < packet.length; cut++) {
      const r = reader();
      r.feed(packet.subarray(0, cut));
      r.feed(packet.subarray(cut));
      expect(r.got).toEqual([]);
      r.feed("draft 界");
      expect(r.got).toEqual([{ name: "char", text: "draft 界" }]);
      expect(r.timers).toBe(0);
    }
  });

  test("coalesced Unicode, reports, Alt, paste and Ctrl+C preserve order at every byte boundary", () => {
    const stream = Buffer.concat([
      Buffer.from(`界é👩‍💻${sgr(64)}${sgr(66)}\x1b[<64M`), x10(65, 194, 160), x10(0),
      Buffer.from("\x1b界\x1b\x7f\x1b[1;3D\x1b[200~paste 界\r\n👩‍💻\x1b[201~\x03end"),
    ]);
    const want: Key[] = [{ name: "char", text: "界é👩‍💻" }, { name: "wheelup" }, { name: "wheeldown" },
      { name: "界", alt: true, text: undefined }, { name: "backspace", alt: true, text: undefined }, { name: "left", alt: true },
      { name: "paste", text: "paste 界\n👩‍💻" }, { name: "c", ctrl: true }, { name: "char", text: "end" }];
    for (let cut = 0; cut <= stream.length; cut++) {
      const r = reader();
      r.feed(stream.subarray(0, cut)); r.feed(stream.subarray(cut));
      expect(normalized(r.got)).toEqual(want);
      expect(r.timers).toBe(0);
    }
    const r = reader();
    for (const byte of stream) r.feed(Uint8Array.of(byte));
    expect(normalized(r.got)).toEqual(want);
  });

  test("Escape and Alt remain responsive; completed packets do not leave an Escape timer", () => {
    const r = reader();
    r.feed("\x1b");
    expect(r.delay).toBe(25);
    r.feed("b");
    expect(r.got).toEqual([{ name: "b", alt: true, text: undefined }]);
    expect(r.timers).toBe(0);
    r.feed("\x1b"); r.fire(); r.feed("b");
    expect(r.got.slice(1)).toEqual([{ name: "escape" }, { name: "char", text: "b" }]);
    r.feed("\x1b"); r.feed(sgr(64).slice(1)); r.fire();
    expect(r.got.at(-1)).toEqual({ name: "wheelup" });
    r.feed("\x1b"); r.close(); r.fire();
    expect(r.got.at(-1)).toEqual({ name: "wheelup" });
  });

  test("incomplete mouse reports time out without Escape/draft mutation; Ctrl+C interrupts malformed packets", () => {
    for (const partial of ["\x1b[<", "\x1b[<64;", "\x1b[M", "\x1b[M`*"]) {
      const r = reader(); r.feed(partial); r.fire();
      expect(r.got).toEqual([]);
      r.feed("ok");
      expect(r.got).toEqual([{ name: "char", text: "ok" }]);
      const quit = reader(); quit.feed(partial); quit.feed("\x03");
      expect(quit.got).toEqual([{ name: "c", ctrl: true }]);
    }
    const r = reader(); r.feed(Buffer.from([0xc2, 3]));
    expect(r.got.at(-1)).toEqual({ name: "c", ctrl: true });
    r.feed("\x1b[<64;\x1b[<65;1;1M");
    expect(r.got.at(-1)).toEqual({ name: "wheeldown" });
  });

  test("idle paste pieces retain incomplete UTF-8 and control-like content stays paste", () => {
    const r = reader();
    r.feed(Buffer.concat([Buffer.from("\x1b[200~a"), Buffer.from("界").subarray(0, 1)]));
    r.fire();
    expect(r.got).toEqual([{ name: "paste", text: "a" }]);
    r.feed(Buffer.concat([Buffer.from("界").subarray(1), Buffer.from(`${sgr(64)}\x1b[201~`)]));
    expect(r.got).toEqual([{ name: "paste", text: "a" }, { name: "paste", text: "界[<64;10;20M" }]);
  });
});

test("keyboard protocols and OSC survive every boundary; Ctrl+C interrupts a pending reply", () => {
  for (const seq of ["\x1bb", "\x1b\x7f", "\x1b\r", "\x1b界", "\x1b\x1b[D", "\x1b[1;3C", "\x1b[27;5;44~", "\x1b[44;5u", "\x1bOA"]) {
    const packet = Buffer.from(seq);
    for (let cut = 1; cut < packet.length; cut++) {
      const r = reader(); r.feed(packet.subarray(0, cut)); r.feed(packet.subarray(cut));
      expect(r.got).toEqual(parseKeys(seq));
      expect(r.timers).toBe(0);
    }
  }
  for (const end of ["\x07", "\x1b\\"]) {
    const seq = `\x1b]11;rgb:0000/0000/0000${end}`;
    for (let cut = 1; cut < seq.length; cut++) {
      const r = replyReader(); r.feed(seq.slice(0, cut)); r.feed(seq.slice(cut));
      expect(r.got).toEqual([REPLY]);
      expect(r.timers).toBe(0);
    }
  }
  const r = replyReader(); r.feed("\x1b]11;rgb:00"); r.feed("\x03");
  expect(r.got).toEqual([{ name: "c", ctrl: true }]);
});


test("a slow UTF-8 character is not replaced at the sequence timeout, including Alt chords", () => {
  for (const prefix of ["", "\x1b"]) {
    const r = reader(), packet = Buffer.from("👩");
    r.feed(Buffer.concat([Buffer.from(prefix), packet.subarray(0, 1)]));
    r.fire();
    expect(r.got).toEqual([]);
    r.feed(packet.subarray(1));
    expect(r.got).toEqual(prefix ? [{ name: "👩", alt: true, text: undefined }] : [{ name: "char", text: "👩" }]);
  }
});
