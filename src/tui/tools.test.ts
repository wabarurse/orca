import { afterEach, describe, expect, test } from "bun:test";
import { commit } from "./render";
import { intensity, shimmer, SHIMMER_MS } from "./shimmer";
import { setTerminalBackground } from "./style";
import { FakeScreen } from "./testing";
import { Calls, runningRow, toolRows } from "./tools";
import { lineRows } from "./lines";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const env = { ...process.env };
afterEach(() => { process.env.NO_COLOR = env.NO_COLOR; if (env.NO_COLOR === undefined) delete process.env.NO_COLOR; setTerminalBackground(null); });
/** Rows written to a FakeScreen (which throws on anything it does not model) and read back. */
const shown = (rows: string[], cols: number) => { const s = new FakeScreen(cols, 6); s.write(commit(rows, cols)); return s.text(); };

describe("tool rows", () => {
  test("a finished call: its line with the name in bold, then the one-line summary; dim marker, red when it failed", () => {
    const ok = toolRows({ tool: "Bash(git status)", summary: "12 lines", failed: false }, 40);
    expect(ok.map(strip)).toEqual(["⏺ Bash(git status)", "  ⎿  12 lines"]);
    expect(ok[0]).toBe("\x1b[2m⏺\x1b[0m \x1b[1mBash\x1b[0m(git status)");
    const bad = toolRows({ tool: "Bash(make)", summary: "exit 2: boom", failed: true }, 40);
    expect(bad[0]!.startsWith("\x1b[31m⏺\x1b[0m ")).toBe(true);
    expect(shown(bad, 40)).toBe("⏺ Bash(make)\n  ⎿  exit 2: boom");
  });

  test("NO_COLOR: no red, a bold marker for a failure", () => {
    process.env.NO_COLOR = "1";
    const bad = toolRows({ tool: "Bash(make)", summary: "exit 2", failed: true }, 40);
    expect(bad[0]!.startsWith("\x1b[1m⏺\x1b[0m ")).toBe(true);
    expect(bad.join("")).not.toContain("\x1b[31m");
  });

  test("cut to narrow widths with …, CJK by display width; escapes in the input cannot get through", () => {
    const rows = toolRows({ tool: "Bash(echo 你好世界 and more)", summary: "a very long first line of output", failed: false }, 14);
    expect(rows.map(strip)).toEqual(["⏺ Bash(echo …", "  ⎿  a very l…"]);
    expect(rows.map((r) => Bun.stringWidth(r)).every((w) => w <= 14)).toBe(true);
    expect(shown(rows, 14)).toBe("⏺ Bash(echo …\n  ⎿  a very l…");
    expect(toolRows({ tool: "Bash(echo 你好)", summary: "1", failed: false }, 15).map(strip)[0]).toBe("⏺ Bash(echo 你…"); // 你 fits, 好 would not
    const tiny = toolRows({ tool: "Bash(ls)", summary: "1 line", failed: false }, 4);
    expect(shown(tiny, 4).split("\n").length).toBe(2);
    expect(strip(toolRows({ tool: "Bash(a\x1b[2Jb)", summary: "x\x07", failed: false }, 40).join("\n"))).toBe("⏺ Bash(ab)\n  ⎿  x");
    expect(lineRows({ tool: "Bash(ls)", summary: "1 line", failed: false }, 20)).toEqual(toolRows({ tool: "Bash(ls)", summary: "1 line", failed: false }, 20));
  });

  test("a running call: the dim marker and its label shimmering, cut to the width", () => {
    const row = runningRow({ name: "bash", input: { command: "git status" } }, 0, 40);
    expect(strip(row)).toBe("⏺ Bash(git status)");
    expect(strip(runningRow({ name: "bash", input: { command: "x".repeat(50) } }, 0, 12))).toBe("⏺ Bash(xxxx…");
    expect(shown([row], 40)).toBe("⏺ Bash(git status)");
  });

  test("Calls pairs a followed transcript's calls and results into lines; an unseen result still shows", () => {
    const calls = new Calls();
    const lines = calls.absorb(["text", { md: "**hi**" }, { call: { id: "a", name: "bash", input: { command: "ls" } } }]);
    expect(lines).toEqual(["text", { md: "**hi**" }]);
    expect(calls.size).toBe(1);
    expect(calls.rows(0, 40).map(strip)).toEqual(["⏺ Bash(ls)"]);
    expect(calls.absorb([{ result: { id: "a", ok: true, text: "x\ny" } }])).toEqual([{ tool: "Bash(ls)", summary: "2 lines", failed: false }]);
    expect(calls.size).toBe(0);
    expect(calls.absorb([{ result: { id: "zz", ok: false, text: "boom" } }])).toEqual([{ tool: "Tool()", summary: "boom", failed: true }]);
  });
});

describe("shimmer", () => {
  test("deterministic in the clock: the same instant gives the same frame; the band sweeps left to right once per period", () => {
    const text = "thinking…";
    expect(shimmer(text, 500)).toBe(shimmer(text, 500));
    expect(shimmer(text, 500)).toBe(shimmer(text, 500 + SHIMMER_MS));
    expect(shimmer(text, 500)).not.toBe(shimmer(text, 900));
    expect(strip(shimmer(text, 123))).toBe(text);
    const peak = (now: number) => [...text].map((_, i) => intensity(i, text.length, now)).reduce((best, v, i, all) => (v > all[best]! ? i : best), 0);
    const at = [0.4, 0.5, 0.6].map((f) => peak(f * SHIMMER_MS));
    expect(at[0]!).toBeLessThan(at[1]!);
    expect(at[1]!).toBeLessThan(at[2]!);
    expect([...text].every((_, i) => intensity(i, text.length, 0) === 0)).toBe(true); // the band starts off the text
  });

  test("without truecolor it steps dim, normal and bold; with truecolor and a known background, a grey blend; NO_COLOR is plain bold", () => {
    const mid = shimmer("abcdefghij", SHIMMER_MS / 2, {});
    expect(mid).toContain("\x1b[1m");
    expect(mid).toContain("\x1b[2m");
    setTerminalBackground({ r: 0, g: 0, b: 0 });
    const tc = shimmer("abcdefghij", SHIMMER_MS / 2, { COLORTERM: "truecolor" });
    expect(tc).toMatch(/\x1b\[38;2;255;255;255m/); // the band's centre: the dark background's opposite
    expect(tc).toMatch(/\x1b\[38;2;115;115;115m/); // outside it: a mid grey
    expect(shown([tc], 20)).toBe("abcdefghij");
    expect(shimmer("abc", 1000, { NO_COLOR: "1" })).toBe("\x1b[1mabc\x1b[0m");
  });
});
