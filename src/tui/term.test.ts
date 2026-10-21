import { afterEach, describe, expect, test } from "bun:test";
import type { Key } from "./keys";
import { setUserFill, userFill } from "./style";
import { realTerminal } from "./term";
import { FakeScreen } from "./testing";

afterEach(() => setUserFill(null));

/** A real terminal over a fake stdin and a FakeScreen stdout, on a manual clock. */
function make(background?: string) {
  const screen = new FakeScreen(40, 5);
  screen.background = background;
  let onData: (chunk: string) => void = () => {};
  const stdin = { isTTY: true, setRawMode() {}, setEncoding() {}, on: (_: string, fn: typeof onData) => { onData = fn; }, off() {}, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 40, rows: 5, write: (s: string) => { screen.write(s); return true; }, on() {} };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const clock = { t: 1000 };
  const term = realTerminal(stdin as never, stdout as never, proc as never, () => clock.t);
  const keys: Key[] = [];
  term.onKey((k) => keys.push(k));
  return { term, screen, clock, keys, input: (s: string) => onData(s) };
}

describe("terminal background (OSC 11)", () => {
  test("open asks once; a reply in time sets the shade, and never reaches the app as keys", () => {
    setUserFill("fallback");
    const t = make("rgb:ffff/ffff/ffff");
    t.term.open();
    expect(t.screen.queries).toBe(1);
    t.clock.t += 50;
    t.input(`${t.screen.replies[0]}hi`);
    expect(t.keys).toEqual([{ name: "char", text: "hi" }]);
    expect(userFill()).not.toBe("fallback");
    expect(userFill()).toMatch(/^\x1b\[48;(5;254|2;230;230;230)m$/); // light: 10% darker
    t.term.close();
    t.term.open();
    expect(t.screen.queries).toBe(1);
    t.term.close();
  });

  test("no answer keeps the fallback; a late or second reply, or another OSC, is dropped", () => {
    setUserFill("fallback");
    const t = make();
    t.term.open();
    expect([t.screen.queries, t.screen.replies]).toEqual([1, []]);
    t.input("x");
    expect(userFill()).toBe("fallback");
    t.input("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    t.clock.t += 1000;
    t.input("\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(userFill()).toBe("fallback");
    t.input("\x1b]11;rgb:0000/0000/0000\x07");
    expect(userFill()).toBe("fallback");
    expect(t.keys).toEqual([{ name: "char", text: "x" }]);
    t.term.close();
  });
});
