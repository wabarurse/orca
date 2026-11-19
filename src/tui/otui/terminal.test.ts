import { afterEach, describe, expect, test } from "bun:test";
import { RGBA, TextAttributes, type CliRendererConfig } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { Key } from "../components";
import { rowChunks, styledRows } from "./ansi";
import { hexColor, openTuiTerminal, type PaintingTerminal, type Proc } from "./terminal";

const tty = { isTTY: true };
const out = { write: () => true, columns: 40, rows: 8, isTTY: true };

type Harness = { term: PaintingTerminal; setup: TestRendererSetup; keys: Key[] };

type FakeProc = Proc & { listeners: Map<string, (reason: unknown) => void>; exits: number[]; errors: string[] };

function fakeProc(): FakeProc {
  const listeners = new Map<string, (reason: unknown) => void>(), exits: number[] = [], errors: string[] = [];
  return {
    listeners, exits, errors,
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    exit: code => { exits.push(code); },
    stderr: { write: text => errors.push(text) },
  };
}

let opened: Harness[] = [];

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > 2000) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function harness(width = 40, height = 8, proc: Proc = fakeProc()): Promise<Harness> {
  let made: TestRendererSetup | null = null;
  const launch = async (config: CliRendererConfig) => {
    made = await createTestRenderer({ ...config, width, height, screenMode: "alternate-screen" });
    return made.renderer;
  };
  const term = openTuiTerminal(launch, tty, out, proc);
  const keys: Key[] = [];
  term.onKey(key => { keys.push(key); });
  term.open();
  await term.background;
  if (made === null) throw new Error("renderer was not created");
  const result = { term, setup: made, keys };
  opened.push(result);
  return result;
}

afterEach(async () => {
  for (const { term } of opened) { term.close(); await term.released; }
  opened = [];
});

describe("ansi rows", () => {
  test("SGR runs become styled chunks and resets end them", () => {
    const chunks = rowChunks("\x1b[1;31mbad\x1b[0m ok \x1b[2mdim\x1b[22m");
    expect(chunks.map(c => c.text)).toEqual(["bad", " ok ", "dim"]);
    expect(chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(chunks[0]?.fg).toEqual(RGBA.fromIndex(1));
    expect(chunks[1]?.fg).toBeUndefined();
    expect(chunks[2]?.attributes).toBe(TextAttributes.DIM);
  });

  test("256-colour, truecolour and background codes", () => {
    const chunks = rowChunks("\x1b[38;5;236mA\x1b[38;2;10;20;30;48;5;4mB\x1b[39;49mC");
    expect(chunks[0]?.fg).toEqual(RGBA.fromIndex(236));
    expect(chunks[1]?.fg).toEqual(RGBA.fromInts(10, 20, 30));
    expect(chunks[1]?.bg).toEqual(RGBA.fromIndex(4));
    expect(chunks[2]?.fg).toBeUndefined();
    expect(chunks[2]?.bg).toBeUndefined();
  });

  test("OSC 8 links carry their target and other escapes are dropped", () => {
    const chunks = rowChunks("see \x1b]8;;https://example.com\x1b\\PR #1\x1b]8;;\x1b\\ now\x1b[K");
    expect(chunks.map(c => c.text).join("")).toBe("see PR #1 now");
    expect(chunks[1]?.link).toEqual({ url: "https://example.com" });
    expect(chunks[2]?.link).toBeUndefined();
  });

  test("rows join with newlines and each row starts unstyled", () => {
    const text = styledRows(["\x1b[1mtop", "next"]);
    expect(text.chunks.map(c => c.text)).toEqual(["top", "\n", "next"]);
    expect(text.chunks[2]?.attributes).toBeUndefined();
  });
});

describe("terminal", () => {
  test("paints frames through the renderer", async () => {
    const { term, setup } = await harness();
    term.paint({ rows: ["\x1b[1mhello\x1b[0m", "", "world"], cursor: 2, col: 5 });
    const frame = await setup.waitForFrame(text => text.includes("world"));
    expect(frame.split("\n").slice(0, 3)).toEqual(["hello", "", "world"].map(row => row.padEnd(40)));
  });

  test("a frame painted before the renderer is up shows once it is", async () => {
    let made: TestRendererSetup | null = null;
    const term = openTuiTerminal(async (config) => { made = await createTestRenderer({ ...config, width: 20, height: 4 }); return made.renderer; }, tty, out, fakeProc());
    term.paint({ rows: ["early"], cursor: 0, col: 0 });
    term.open();
    await term.background;
    opened.push({ term, setup: made ?? (() => { throw new Error("no renderer"); })(), keys: [] });
    const setup = opened[0]?.setup;
    if (setup === undefined) throw new Error("no setup");
    expect(await setup.waitForFrame(text => text.includes("early"))).toContain("early");
  });

  test("keys arrive as orca keys", async () => {
    const { setup, keys } = await harness();
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("n", { ctrl: true });
    setup.mockInput.pressKey("c", { ctrl: true });
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressKey("ARROW_UP");
    setup.mockInput.pressEscape();
    await until(() => keys.length >= 8);
    expect(keys).toEqual([
      { name: "char", text: "h" }, { name: "char", text: "i" }, { name: "enter" }, { name: "n", ctrl: true }, { name: "c", ctrl: true },
      { name: "tab", shift: true }, { name: "up" }, { name: "escape" },
    ]);
  });

  test("Option+Backspace sent as two writes (Terminal.app's way) is one Alt+Backspace", async () => {
    const { setup, keys } = await harness();
    setup.renderer.stdin.emit("data", Buffer.from("\x1b"));
    await Bun.sleep(5);
    setup.renderer.stdin.emit("data", Buffer.from("\x7f"));
    await until(() => keys.length > 0);
    await Bun.sleep(50);
    expect(keys).toEqual([{ name: "backspace", alt: true }]);
  });

  test("kitty-keyboard Option+Delete is Alt+Backspace and releases never edit twice", async () => {
    const made: { setup: TestRendererSetup | null } = { setup: null };
    const term = openTuiTerminal(async (config) => {
      const setup = await createTestRenderer({ ...config, width: 20, height: 4, kittyKeyboard: true });
      made.setup = setup;
      return setup.renderer;
    }, tty, out, fakeProc());
    const keys: Key[] = [];
    term.onKey(key => { keys.push(key); });
    term.open();
    await term.background;
    const setup = made.setup;
    if (setup === null) throw new Error("no renderer");
    opened.push({ term, setup, keys });
    setup.mockInput.pressBackspace({ meta: true });
    await until(() => keys.length > 0);
    await Bun.sleep(30);
    expect(keys).toEqual([{ name: "backspace", alt: true }]);
  });

  test("a paste arrives as one cleaned paste key", async () => {
    const { setup, keys } = await harness();
    setup.renderer.stdin.emit("data", Buffer.from("\x1b[200~a\r\nb\tc\x1b[201~"));
    await until(() => keys.length > 0);
    expect(keys).toEqual([{ name: "paste", text: "a\nb    c" }]);
  });

  test("left clicks, drags and the wheel become mouse keys with one-based cells", async () => {
    const { term, setup, keys } = await harness();
    term.paint({ rows: ["x"], cursor: 0, col: 0 });
    await setup.renderOnce();
    await setup.mockMouse.click(3, 2);
    await setup.mockMouse.drag(1, 1, 5, 1);
    await setup.mockMouse.scroll(2, 2, "down");
    await until(() => keys.some(key => key.name === "wheeldown"));
    expect(keys[0]).toEqual({ name: "mousedown", x: 4, y: 3 });
    expect(keys[1]).toEqual({ name: "mouseup", x: 4, y: 3 });
    expect(keys.filter(key => key.name === "mousemove").length).toBeGreaterThan(0);
    expect(keys.at(-1)).toEqual({ name: "wheeldown" });
  });

  test("resizes update the size and tell the app", async () => {
    const { term, setup } = await harness();
    let told = 0;
    term.onResize(() => { told += 1; });
    setup.resize(60, 12);
    await until(() => told > 0);
    expect([term.cols, term.rows]).toEqual([60, 12]);
  });

  test("closing hands the screen back and stops keys", async () => {
    const { term, setup, keys } = await harness();
    term.close();
    await term.released;
    expect(setup.renderer.isDestroyed).toBe(true);
    expect(keys).toEqual([]);
  });

  test("SIGTERM and SIGHUP hand the screen back and exit like a killed shell job; a crash prints its stack", async () => {
    for (const [event, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const proc = fakeProc();
      const { setup } = await harness(40, 8, proc);
      proc.listeners.get(event)?.(undefined);
      expect(setup.renderer.isDestroyed).toBe(true);
      expect(proc.exits).toEqual([code]);
      expect(proc.listeners.size).toBe(0);
    }
    const proc = fakeProc();
    await harness(40, 8, proc);
    proc.listeners.get("uncaughtException")?.(new Error("boom"));
    expect(proc.exits).toEqual([1]);
    expect(proc.errors.join("")).toContain("boom");
  });

  test("needs a terminal", () => {
    expect(() => openTuiTerminal(async () => { throw new Error("unused"); }, { isTTY: false }, out)).toThrow("needs a terminal");
  });

  test("palette backgrounds parse as hex", () => {
    expect(hexColor("#1e1f2a")).toEqual({ r: 30, g: 31, b: 42 });
    expect(hexColor("nope")).toBeNull();
  });
});
