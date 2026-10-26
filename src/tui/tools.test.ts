import { afterEach, describe, expect, test } from "bun:test";
import { commit } from "./render";
import { intensity, shimmer, SHIMMER_MS } from "./shimmer";
import { setTerminalBackground } from "./style";
import { FakeScreen } from "./testing";
import { Calls, collapseCalls, groupRow, groupStart, groupStarts, runningRow, toolRows } from "./tools";
import { historyRows, lineRows, type Line } from "./lines";

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "");
const env = { ...process.env };
afterEach(() => { process.env.NO_COLOR = env.NO_COLOR; if (env.NO_COLOR === undefined) delete process.env.NO_COLOR; setTerminalBackground(null); });
/** Rows written to a FakeScreen (which throws on anything it does not model) and read back. */
const shown = (rows: string[], cols: number) => { const s = new FakeScreen(cols, 6); s.write(commit(rows, cols)); return s.text(); };

describe("tool rows", () => {
  test("a finished call: its line with the name in bold, then the one-line summary; dim marker, red when it failed", () => {
    const ok = toolRows({ tool: "bash(git status)", summary: "12 lines", failed: false }, 40);
    expect(ok.map(strip)).toEqual(["⏺ bash(git status)", "  ⎿  12 lines"]);
    expect(ok[0]).toBe("\x1b[2m⏺\x1b[0m \x1b[1mbash\x1b[0m(git status)");
    const bad = toolRows({ tool: "bash(make)", summary: "exit 2: boom", failed: true }, 40);
    expect(bad[0]!.startsWith("\x1b[31m⏺\x1b[0m ")).toBe(true);
    expect(shown(bad, 40)).toBe("⏺ bash(make)\n  ⎿  exit 2: boom");
  });

  test("NO_COLOR: no red, a bold marker for a failure", () => {
    process.env.NO_COLOR = "1";
    const bad = toolRows({ tool: "bash(make)", summary: "exit 2", failed: true }, 40);
    expect(bad[0]!.startsWith("\x1b[1m⏺\x1b[0m ")).toBe(true);
    expect(bad.join("")).not.toContain("\x1b[31m");
  });

  test("cut to narrow widths with …, CJK by display width; escapes in the input cannot get through", () => {
    const rows = toolRows({ tool: "bash(echo 你好世界 and more)", summary: "a very long first line of output", failed: false }, 14);
    expect(rows.map(strip)).toEqual(["⏺ bash(echo …", "  ⎿  a very l…"]);
    expect(rows.map((r) => Bun.stringWidth(r)).every((w) => w <= 14)).toBe(true);
    expect(shown(rows, 14)).toBe("⏺ bash(echo …\n  ⎿  a very l…");
    expect(toolRows({ tool: "bash(echo 你好)", summary: "1", failed: false }, 15).map(strip)[0]).toBe("⏺ bash(echo 你…"); // 你 fits, 好 would not
    const tiny = toolRows({ tool: "bash(ls)", summary: "1 line", failed: false }, 4);
    expect(shown(tiny, 4).split("\n").length).toBe(2);
    expect(strip(toolRows({ tool: "bash(a\x1b[2Jb)", summary: "x\x07", failed: false }, 40).join("\n"))).toBe("⏺ bash(ab)\n  ⎿  x");
    expect(lineRows({ tool: "bash(ls)", summary: "1 line", failed: false }, 20)).toEqual(toolRows({ tool: "bash(ls)", summary: "1 line", failed: false }, 20));
  });

  test("a run of finished calls folds into one dim summary line: count, per-tool tally (most first, ties in call order), failures; the tally gives way first on narrow widths", () => {
    const call = (tool: string, failed = false) => ({ tool, summary: failed ? "exit 1" : "ok", failed });
    const seven = [call("bash(a)"), call("read(x)"), call("bash(b)", true), call("edit(y)"), call("bash(c)"), call("read(z)"), call("bash(d)")];
    expect(strip(groupRow(seven, 80))).toBe("⏺ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed");
    expect(groupRow(seven, 80)).toBe(`\x1b[31m⏺\x1b[0m \x1b[2m7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed\x1b[0m`);
    expect(groupRow([call("bash(a)"), call("bash(b)")], 80)).toBe(`\x1b[2m⏺\x1b[0m \x1b[2m2 tool calls · bash ×2\x1b[0m`);
    expect(strip(groupRow([call("read(a)"), call("bash(b)")], 80))).toBe("⏺ 2 tool calls · read ×1, bash ×1"); // a tie keeps the first call's tool first
    expect(strip(groupRow([call("bash(a)", true)], 80))).toBe("⏺ 1 tool call · bash ×1 · 1 failed");
    expect(strip(groupRow(seven, 40))).toBe("⏺ 7 tool calls · bash ×4, re… · 1 failed");
    expect(strip(groupRow(seven, 25))).toBe("⏺ 7 tool calls · 1 failed"); // no room for a useful tally: dropped, the failures kept
    expect(strip(groupRow(seven, 10))).toBe("⏺ 7 tool …");
    for (const cols of [80, 40, 24, 10, 3]) expect(Bun.stringWidth(strip(groupRow(seven, cols)))).toBeLessThanOrEqual(cols);
    expect(shown([groupRow(seven, 60)], 60)).toBe("⏺ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed");
    expect(strip(groupRow([call("bash(a\x1b[2Jb)"), call("x\x07(y)")], 80))).toBe("⏺ 2 tool calls · bash ×1, x ×1");
    process.env.NO_COLOR = "1";
    expect(groupRow(seven, 80).startsWith("\x1b[1m⏺\x1b[0m ")).toBe(true);
  });

  test("collapseCalls folds runs of two or more calls into { calls } lines, leaves lone calls and everything else alone; one summary row with a blank before and after", () => {
    const a = { tool: "bash(a)", summary: "1 line", failed: false }, b = { tool: "read(b)", summary: "ok", failed: false }, c = { tool: "bash(c)", summary: "interrupted", failed: true };
    const lines: Line[] = [{ user: "> go" }, a, b, c, { md: "text", block: true }, a, "note", b, c];
    expect(collapseCalls(lines)).toEqual([{ user: "> go" }, { calls: [a, b, c] }, { md: "text", block: true }, a, "note", { calls: [b, c] }]);
    expect(collapseCalls([])).toEqual([]);
    expect(collapseCalls([a])).toEqual([a]);
    expect(lineRows({ calls: [a, b] }, 40)).toEqual([groupRow([a, b], 40)]);
    expect(historyRows(collapseCalls([{ md: "text", block: true }, a, b, { md: "more", block: true }]), 40).map(strip)).toEqual(["text", "", "⏺ 2 tool calls · bash ×1, read ×1", "", "more"]);
    expect(historyRows([{ md: "text", block: true }, a, b, { md: "more", block: true }], 40).map(strip)).toEqual(["text", "", "⏺ bash(a)", "  ⎿  1 line", "", "⏺ read(b)", "  ⎿  ok", "", "more"]); // expanded: as before
  });

  test("a group opened by a click (its run's start index) keeps its summary row with every call indented under it; groups are found by where their runs start", () => {
    const a = { tool: "bash(a)", summary: "1 line", failed: false }, b = { tool: "read(b)", summary: "ok", failed: false }, c = { tool: "bash(c)", summary: "interrupted", failed: true };
    const lines: Line[] = [{ user: "> go" }, a, b, c, { md: "text", block: true }, a, "note", b, c];
    expect(groupStarts(lines)).toEqual([1, 7]);
    expect(groupStarts([a])).toEqual([]);
    const shown = collapseCalls(lines, new Set([7]));
    expect(shown).toEqual([{ user: "> go" }, { calls: [a, b, c] }, { md: "text", block: true }, a, "note", { calls: [b, c], open: true }]);
    expect(groupStart(lines, shown, 1)).toBe(1);
    expect(groupStart(lines, shown, 5)).toBe(7);
    expect(groupStart(lines, shown, 3)).toBeUndefined(); // a lone call is no group
    expect(groupStart(lines, shown, 0)).toBeUndefined();
    expect(lineRows({ calls: [a, c], open: true }, 40).map(strip)).toEqual(["⏺ 2 tool calls · bash ×2 · 1 failed", "  ⏺ bash(a)", "    ⎿  1 line", "  ⏺ bash(c)", "    ⎿  interrupted"]);
    for (const row of lineRows({ calls: [a, c], open: true }, 12)) expect(Bun.stringWidth(strip(row))).toBeLessThanOrEqual(12);
  });

  test("a running call: the dim marker and its label shimmering, cut to the width", () => {
    const row = runningRow({ name: "bash", input: { command: "git status" } }, 0, 40);
    expect(strip(row)).toBe("⏺ bash(git status)");
    expect(strip(runningRow({ name: "bash", input: { command: "x".repeat(50) } }, 0, 12))).toBe("⏺ bash(xxxx…");
    expect(shown([row], 40)).toBe("⏺ bash(git status)");
  });

  test("Calls pairs a followed transcript's calls and results into lines; an unseen result still shows", () => {
    const calls = new Calls();
    const lines = calls.absorb(["text", { md: "**hi**" }, { call: { id: "a", name: "bash", input: { command: "ls" } } }]);
    expect(lines).toEqual(["text", { md: "**hi**" }]);
    expect(calls.size).toBe(1);
    expect(calls.rows(0, 40).map(strip)).toEqual(["⏺ bash(ls)"]);
    expect(calls.absorb([{ result: { id: "a", ok: true, text: "x\ny" } }])).toEqual([{ tool: "bash(ls)", summary: "2 lines", failed: false }]);
    expect(calls.size).toBe(0);
    expect(calls.absorb([{ result: { id: "zz", ok: false, text: "boom" } }])).toEqual([{ tool: "tool()", summary: "boom", failed: true }]);
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

test("untrusted escapes cannot be split by the shimmer at any phase", () => {
  for (const now of [0, 400, 800, 1200, 1600]) {
    const row = runningRow({ name: "bash", input: { command: "\x1b[31mred\x1b[0m \x1b]8;;x\x07link\x1b]8;;\x07\x1b]52;c;evil\x07" } }, now, 50);
    expect(shown([row], 50)).toBe("⏺ bash(red link)");
  }
  const calls = new Calls();
  calls.start({ id: "a", name: "bash", input: { command: "sleep 99" } });
  expect(calls.interrupt()).toEqual([{ tool: "bash(sleep 99)", summary: "interrupted", failed: true }]);
  expect(calls.size).toBe(0);
});
