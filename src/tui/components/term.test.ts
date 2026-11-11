import { afterEach, describe, expect, test } from "bun:test";
import type { Key } from "./keys";
import { BG_REPLY_MS, setUserFill, userFill } from "./style";
import { realTerminal } from "./term";
import { FakeScreen } from "./testing";

afterEach(() => setUserFill(null));

/** A real terminal over a fake stdin and a FakeScreen stdout, on a manual clock and timers. */
function make(background?: string) {
  const screen = new FakeScreen(40, 5);
  screen.background = background;
  let onData: ((chunk: string | Uint8Array) => void) | null = null;
  const raw: boolean[] = [];
  const writes: string[] = [];
  const stdin = { isTTY: true, setRawMode: (on: boolean) => { raw.push(on); }, setEncoding() {}, on: (_: string, fn: (c: string | Uint8Array) => void) => { onData = fn; }, off: () => { onData = null; }, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 40, rows: 5, write: (s: string) => { writes.push(s); screen.write(s); return true; }, on() {} };
  const procHandlers = new Map<string, (...a: unknown[]) => void>();
  const proc = { on: (e: string, fn: () => void) => { procHandlers.set(e, fn); }, off: (e: string) => { procHandlers.delete(e); }, exit() {}, stderr: { write() {} } };
  const timers: { at: number; fn: () => void }[] = [];
  const clock = { t: 1000, now: () => clock.t, setTimer: (fn: () => void, ms: number) => { const e = { at: clock.t + ms, fn }; timers.push(e); return () => { timers.splice(timers.indexOf(e), 1); }; } };
  /** Move the clock on, firing timers that come due. */
  const advance = (ms: number) => {
    clock.t += ms;
    for (const e of [...timers].filter((e) => e.at <= clock.t)) { timers.splice(timers.indexOf(e), 1); e.fn(); }
  };
  const term = realTerminal(stdin as never, stdout as never, proc as never, clock);
  const keys: Key[] = [];
  term.onKey((k) => keys.push(k));
  return { term, screen, clock, advance, keys, raw, writes, procHandlers, timers, input: (s: string | Uint8Array) => onData?.(s), get reading() { return onData !== null; } };
}

test("held-Space mode is deduplicated and disabled on every terminal exit", () => {
  const on = "\x1b]777;orca;space-chords=1\x07", off = "\x1b]777;orca;space-chords=0\x07";
  for (const exit of ["close", "SIGTERM", "SIGHUP", "uncaughtException", "exit"]) {
    const t = make();
    t.term.setSpaceChords?.(true); expect(t.writes).toEqual([]);
    t.term.open(); t.advance(BG_REPLY_MS);
    t.term.setSpaceChords?.(true); t.term.setSpaceChords?.(true);
    expect(t.writes.filter(s => s === on)).toHaveLength(1);
    t.term.setSpaceChords?.(false); t.term.setSpaceChords?.(false);
    expect(t.writes.filter(s => s === off)).toHaveLength(1);
    t.term.setSpaceChords?.(true);
    if (exit === "close") t.term.close(); else t.procHandlers.get(exit)!(new Error("test"));
    expect(t.writes.at(-1)).toContain(off);
    t.term.open(); t.term.setSpaceChords?.(true);
    expect(t.writes.at(-1)).toBe(on);
    t.term.close();
  }
});

const settled = async (p: Promise<void> | undefined) => {
  let done = false;
  p?.then(() => { done = true; });
  await Bun.sleep(0);
  return done;
};

test("sticky screen and mouse modes restore the primary screen on close and crash", () => {
  for (const crash of [false, true]) {
    const t = make();
    t.screen.write("shell prompt\r\n");
    const before = t.screen.text();
    t.term.open();
    t.advance(BG_REPLY_MS);
    expect(t.screen.modes.get(1049)).toBe(true);
    for (const mode of [1000, 1002, 1006]) expect(t.screen.modes.get(mode)).toBe(true);
    t.screen.write("agent screen");
    expect(t.screen.text()).not.toContain("shell prompt");
    if (crash) t.procHandlers.get("SIGTERM")!();
    else t.term.close();
    expect(t.screen.text()).toBe(before);
    for (const mode of [1049, 1000, 1002, 1006, 2004]) expect(t.screen.modes.get(mode)).toBe(false);
    expect(t.raw).toEqual([true, false]);
  }
});

describe("terminal background (OSC 11)", () => {
  test("open asks once; a reply in time sets the shade, settles `background`, and never reaches the app as keys", async () => {
    setUserFill("fallback");
    const t = make("rgb:ffff/ffff/ffff");
    t.term.open();
    expect(t.screen.queries).toBe(1);
    expect(await settled(t.term.background)).toBe(false);
    t.advance(50);
    t.input(`${t.screen.replies[0]}hi`);
    expect(await settled(t.term.background)).toBe(true);
    expect(t.keys).toEqual([{ name: "char", text: "hi" }]);
    expect(userFill()).toMatch(/^\x1b\[48;(5;254|2;230;230;230)m$/); // light: 10% darker
    expect(t.timers).toEqual([]);
    t.term.close();
    expect(t.raw).toEqual([true, false]); // answered: nothing to wait for
    t.term.open();
    expect(t.screen.queries).toBe(1);
    t.term.close();
  });

  test("no answer: `background` settles after the window with the fallback kept; a late reply or another OSC is dropped", async () => {
    setUserFill("fallback");
    const t = make();
    t.term.open();
    expect([t.screen.queries, t.screen.replies]).toEqual([1, []]);
    t.input("x");
    t.input("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    t.advance(BG_REPLY_MS);
    expect(await settled(t.term.background)).toBe(true);
    t.input("\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(userFill()).toBe("fallback");
    expect(t.keys).toEqual([{ name: "char", text: "x" }]);
    t.term.close();
  });

  test("a reply split right after its ESC is still one reply, not Esc and typed text", () => {
    const t = make();
    t.term.open();
    t.input("\x1b");
    t.input("]11;rgb:0000/0000/0000\x1b\\");
    expect(t.keys).toEqual([]);
    expect(userFill()).toMatch(/^\x1b\[48;5;234m$|^\x1b\[48;2;26;26;26m$/);
    t.term.close();
  });

  test("closing while the reply is expected keeps reading stdin in raw mode until it comes, then hands the terminal back", () => {
    const t = make();
    t.term.open();
    t.advance(100);
    t.term.close();
    expect(t.raw).toEqual([true]); // still raw: the reply must not reach the shell
    expect(t.reading).toBe(true);
    t.input("\x1b]11;rgb:0000/0000/0000\x07z");
    expect(t.keys).toEqual([]); // closed: nothing reaches the app
    expect(t.raw).toEqual([true, false]);
    expect(t.reading).toBe(false);
    expect(t.procHandlers.size).toBe(0);

    const silent = make();
    silent.term.open();
    silent.term.close();
    expect(silent.raw).toEqual([true]);
    silent.advance(BG_REPLY_MS);
    expect(silent.raw).toEqual([true, false]); // the window ended
    expect(silent.procHandlers.size).toBe(0);

    const killed = make();
    killed.term.open();
    killed.term.close();
    killed.procHandlers.get("exit")!();
    expect(killed.raw).toEqual([true, false]); // exiting mid-drain still leaves raw mode
  });
});

test("raw mouse bytes and fragmented UTF-8 survive the terminal after the OSC window; close/crash drop held input", async () => {
  for (const crash of [false, true]) {
    const t = make();
    t.term.open(); t.advance(BG_REPLY_MS);
    const stream = Buffer.concat([Buffer.from("\x1b[<64;1;2M"), Buffer.from([27, 91, 77, 97, 194, 160]), Buffer.from("界👩‍💻")]);
    for (const byte of stream) t.input(Uint8Array.of(byte));
    expect(t.keys.slice(0, 2)).toEqual([{ name: "wheelup" }, { name: "wheeldown" }]);
    expect(t.keys.slice(2).map(k => k.text).join("")).toBe("界👩‍💻");
    t.input("\x1b"); // the new short timer must not survive cleanup
    if (crash) t.procHandlers.get("SIGTERM")!(); else t.term.close();
    expect(t.reading).toBe(false);
    await Bun.sleep(40);
    expect(t.keys.some(k => k.name === "escape")).toBe(false);
    expect(t.raw).toEqual([true, false]);
    expect(t.procHandlers.size).toBe(0);
  }
});

test("terminal titles are plain, deduplicated, and only written while open", () => {
  const writes: string[] = [];
  const stdin = { isTTY: true, setRawMode() {}, on() {}, off() {}, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 80, rows: 24, write(s: string) { writes.push(s); }, on() {} };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc as never, { now: () => 0, setTimer: () => () => {} });
  term.setTitle!("orca · closed");
  expect(writes).toEqual([]);
  term.open();
  writes.length = 0;
  term.setTitle!("orca · phoebe");
  term.setTitle!("orca · phoebe");
  expect(writes).toEqual(["\x1b]0;orca · phoebe\x07"]);
  term.setTitle!("orca · other\x1b]0;injected\x07\x1b[31m\u202e\nrepo");
  expect(writes.at(-1)).toBe("\x1b]0;orca · other repo\x07");
  term.close();
  const count = writes.length;
  term.setTitle!("orca · ignored");
  expect(writes.length).toBe(count);
});

test("image capability replies are consumed, invalid metrics ignored, and changed cells redraw without a query loop", () => {
  const t = make(); let redraws = 0;
  t.term.onResize(() => redraws++);
  t.term.open();
  expect(t.term.inlineImages).toBe(false);
  for (const value of ["0;8", "16;0", "Infinity;8", "16;NaN"]) t.input(`\x1b]1337;ReportCellSize=${value}\x07`);
  expect(t.term.inlineImages).toBe(false);
  t.input("\x1b]1337;ReportCellSize=16;8.4;2\x07");
  expect(t.term.inlineImages).toBe(true);
  expect(t.term.imageCell).toEqual({ height: 16, width: 8.4 });
  expect(redraws).toBe(1);
  t.input("\x1b]1337;ReportCellSize=16;8.4\x07");
  expect(redraws).toBe(1);
  t.input("\x1b]1337;ReportCellSize=18;9\x07");
  expect(redraws).toBe(2);
  expect(t.keys).toEqual([]);
  t.term.close(); t.advance(BG_REPLY_MS);
});
