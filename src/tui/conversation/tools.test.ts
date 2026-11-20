import { afterEach, describe, expect, test } from "bun:test";
import { commit } from "../footer/render";
import { intensity, shimmer, SHIMMER_MS } from "../components/shimmer";
import { setTerminalBackground } from "../components/style";
import { FakeScreen } from "../components/testing";
import { Calls, collapseCalls, foldKeys, foldRows, foldTitle, groupRow, runningRow, toolRows } from "./tools";
import { historyRows, lineRows, type CallLine, type Line } from "./lines";

const tool = (tool: string, summary: string, failed: boolean): CallLine => ({ tool, summary, failed, kind: "tool", items: [] });

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
    expect(bad[0]!.startsWith("\x1b[38;5;217m⏺\x1b[0m ")).toBe(true);
    expect(shown(bad, 40)).toBe("⏺ bash(make)\n  ⎿  exit 2: boom");
  });

  test("NO_COLOR: no red, a bold marker for a failure", () => {
    process.env.NO_COLOR = "1";
    const bad = toolRows({ tool: "bash(make)", summary: "exit 2", failed: true }, 40);
    expect(bad[0]!.startsWith("\x1b[1m⏺\x1b[0m ")).toBe(true);
    expect(bad.join("")).not.toContain("\x1b[38;5;217m");
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
    expect(lineRows(tool("bash(ls)", "1 line", false), 20)).toEqual(toolRows({ tool: "bash(ls)", summary: "1 line", failed: false }, 20));
  });

  test("a run of finished calls folds into one dim summary line: count, per-tool tally (most first, ties in call order), failures; the tally gives way first on narrow widths", () => {
    const call = (tool: string, failed = false) => ({ tool, summary: failed ? "exit 1" : "ok", failed });
    const seven = [call("bash(a)"), call("read(x)"), call("bash(b)", true), call("edit(y)"), call("bash(c)"), call("read(z)"), call("bash(d)")];
    expect(strip(groupRow(seven, 80))).toBe("▸ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed");
    expect(groupRow(seven, 80)).toBe(`\x1b[38;5;217m▸\x1b[0m \x1b[2m7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed\x1b[0m`);
    expect(groupRow([call("bash(a)"), call("bash(b)")], 80)).toBe(`\x1b[2m▸\x1b[0m \x1b[2m2 tool calls · bash ×2\x1b[0m`);
    expect(groupRow([call("bash(a)"), call("bash(b)")], 80, true)).toBe(`\x1b[2m▾\x1b[0m \x1b[2m2 tool calls · bash ×2\x1b[0m`); // opened by a click
    expect(strip(groupRow([call("read(a)"), call("bash(b)")], 80))).toBe("▸ 2 tool calls · read ×1, bash ×1"); // a tie keeps the first call's tool first
    expect(strip(groupRow([call("bash(a)", true)], 80))).toBe("▸ 1 tool call · bash ×1 · 1 failed");
    expect(strip(groupRow(seven, 40))).toBe("▸ 7 tool calls · bash ×4, re… · 1 failed");
    expect(strip(groupRow(seven, 25))).toBe("▸ 7 tool calls · 1 failed"); // no room for a useful tally: dropped, the failures kept
    expect(strip(groupRow(seven, 10))).toBe("▸ 7 tool …");
    for (const cols of [80, 40, 24, 10, 3]) expect(Bun.stringWidth(strip(groupRow(seven, cols)))).toBeLessThanOrEqual(cols);
    expect(shown([groupRow(seven, 60)], 60)).toBe("▸ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed");
    expect(strip(groupRow([call("bash(a\x1b[2Jb)"), call("x\x07(y)")], 80))).toBe("▸ 2 tool calls · bash ×1, x ×1");
    process.env.NO_COLOR = "1";
    expect(groupRow(seven, 80).startsWith("\x1b[1m▸\x1b[0m ")).toBe(true);
  });

  test("collapseCalls folds runs of two or more calls into { calls } lines, leaves lone calls and everything else alone; one summary row with a blank before and after", () => {
    const a = tool("bash(a)", "1 line", false), b = tool("read(b)", "ok", false), c = tool("bash(c)", "interrupted", true);
    const lines: Line[] = [{ user: "> go" }, a, b, c, { md: "text", block: true }, a, "note", b, c];
    expect(collapseCalls(lines)).toEqual([{ user: "> go" }, { calls: [a, b, c], open: false, key: "calls:1" }, { md: "text", block: true }, a, "note", { calls: [b, c], open: false, key: "calls:7" }]);
    expect(collapseCalls([])).toEqual([]);
    expect(collapseCalls([a])).toEqual([a]);
    expect(lineRows({ calls: [a, b], open: false, key: "calls:0" }, 40)).toEqual([groupRow([a, b], 40)]);
    expect(historyRows(collapseCalls([{ md: "text", block: true }, a, b, { md: "more", block: true }]), 40).map(strip)).toEqual(["text", "", "▸ 2 tool calls · bash ×1, read ×1", "", "more"]);
    expect(historyRows([{ md: "text", block: true }, a, b, { md: "more", block: true }], 40).map(strip)).toEqual(["text", "", "⏺ bash(a)", "  ⎿  1 line", "", "⏺ read(b)", "  ⎿  ok", "", "more"]); // expanded: as before
  });

  test("a fold opened by a click (its key: kind and the run's start index) keeps its summary row with every call indented under it", () => {
    const a = tool("bash(a)", "1 line", false), b = tool("read(b)", "ok", false), c = tool("bash(c)", "interrupted", true);
    const lines: Line[] = [{ user: "> go" }, a, b, c, { md: "text", block: true }, a, "note", b, c];
    const shown = collapseCalls(lines, new Set(["calls:7"]));
    expect(shown).toEqual([{ user: "> go" }, { calls: [a, b, c], open: false, key: "calls:1" }, { md: "text", block: true }, a, "note", { calls: [b, c], open: true, key: "calls:7" }]);
    expect(foldKeys(shown)).toEqual(["calls:1", "calls:7"]);
    expect(foldKeys(collapseCalls([a]))).toEqual([]); // a lone call is no fold
    expect(collapseCalls(lines, new Set(["7"]))).toEqual(collapseCalls(lines)); // a bare index is no key
    expect(lineRows({ calls: [a, c], open: true, key: "calls:0" }, 40).map(strip)).toEqual(["▾ 2 tool calls · bash ×2 · 1 failed", "  ⏺ bash(a)", "    ⎿  1 line", "  ⏺ bash(c)", "    ⎿  interrupted"]);
    for (const row of lineRows({ calls: [a, c], open: true, key: "calls:0" }, 12)) expect(Bun.stringWidth(strip(row))).toBeLessThanOrEqual(12);
  });

  test("a run with ask, spawn and task calls and images: the calls fold, then + N questions, images, agents, tasks in that order, each keyed by the run's start", () => {
    const a = tool("bash(a)", "ok", false), b = tool("read(b)", "ok", false);
    const ask: CallLine = { tool: "ask(Which?)", summary: "asked", failed: false, kind: "question", items: ["Which?", "Why?"] };
    const spawn: CallLine = { tool: "spawn(fix, worker)", summary: "spawned worker-a", failed: false, kind: "agent", items: ["worker-a · fix · worker"] };
    const task: CallLine = { tool: "task(create)", summary: "ok", failed: false, kind: "task", items: ["Fix it"] };
    const lines: Line[] = ["intro", task, a, { image: "shot.png" }, spawn, ask, b];
    expect(collapseCalls(lines)).toEqual([
      "intro",
      { calls: [a, b], open: false, key: "calls:1" },
      { group: "questions", items: ["Which?", "Why?"], open: false, key: "questions:1" },
      { group: "images", items: ["shot.png"], open: false, key: "images:1" },
      { group: "agents", items: ["worker-a · fix · worker"], open: false, key: "agents:1" },
      { group: "tasks", items: ["Fix it"], open: false, key: "tasks:1" },
    ]);
    const opened = collapseCalls(lines, new Set(["agents:1", "calls:1"]));
    expect(foldKeys(opened)).toEqual(["calls:1", "questions:1", "images:1", "agents:1", "tasks:1"]);
    expect(opened.flatMap(l => typeof l !== "string" && "open" in l && l.open ? [l.key] : [])).toEqual(["calls:1", "agents:1"]);
    expect(collapseCalls([ask])).toEqual([{ group: "questions", items: ["Which?", "Why?"], open: false, key: "questions:0" }]); // no ordinary call: no calls fold
    expect(collapseCalls([a, spawn])).toEqual([a, { group: "agents", items: ["worker-a · fix · worker"], open: false, key: "agents:0" }]); // one ordinary call stays as it is
  });

  test("a failed ask stays an ordinary tool call", () => {
    const failed: CallLine = { tool: "ask(Which?)", summary: "refused: no", failed: true, kind: "tool", items: [] };
    const a = tool("bash(a)", "ok", false);
    expect(collapseCalls([failed])).toEqual([failed]);
    expect(collapseCalls([a, failed])).toEqual([{ calls: [a, failed], open: false, key: "calls:0" }]);
    const calls = new Calls();
    calls.start({ id: "q", name: "ask", input: { questions: [{ text: "Which?" }] } });
    expect(calls.finish({ id: "q", ok: false, text: "boom" })).toMatchObject({ failed: true, kind: "tool", items: [] });
  });

  test("an agent's message is a from fold keyed by its own index", () => {
    const shown = collapseCalls(["x", { from: "worker-a", text: "done" }], new Set(["from:1"]));
    expect(shown).toEqual(["x", { from: "worker-a", text: "done", open: true, key: "from:1" }]);
    expect(foldKeys(shown)).toEqual(["from:1"]);
  });

  test("fold titles and their exit-transcript rows: closed ▸ title; open groups list ● items, open messages ⎿ their text", () => {
    expect(foldTitle({ calls: [tool("a()", "", false), tool("b()", "", false)], open: false, key: "calls:0" })).toBe("2 tool calls");
    expect(foldTitle({ group: "questions", items: ["a", "b"], open: false, key: "questions:0" })).toBe("+ 2 questions");
    expect(foldTitle({ group: "images", items: ["a"], open: false, key: "images:0" })).toBe("+ 1 image");
    expect(foldTitle({ from: "worker-a", text: "x", open: false, key: "from:0" })).toBe("from worker-a");
    expect(foldRows({ group: "agents", items: ["worker-a"], open: false, key: "agents:0" }, 40).map(strip)).toEqual(["▸ + 1 agent"]);
    expect(foldRows({ group: "tasks", items: ["Fix it", "Ship \x1b[2Jit"], open: true, key: "tasks:0" }, 40).map(strip)).toEqual(["▾ + 2 tasks", "  ● Fix it", "  ● Ship it"]);
    expect(foldRows({ from: "worker-a", text: "done", open: false, key: "from:0" }, 40).map(strip)).toEqual(["▸ from worker-a"]);
    expect(foldRows({ from: "worker-a", text: "abcdefghij ok", open: true, key: "from:0" }, 13).map(strip)).toEqual(["▾ from worke…", "  ⎿  abcdefgh", "     ij ok"]); // wrapped to the width left beside ⎿, continuations under the text
    expect(foldRows({ from: "worker-a", text: "x" }, 40).map(strip)).toEqual(["▸ from worker-a"]); // the history line itself: closed
    expect(foldRows({ image: "shot.png" }, 40).map(strip)).toEqual(["shot.png"]);
    for (const row of foldRows({ group: "tasks", items: ["a very long task title indeed"], open: true, key: "tasks:0" }, 12)) expect(Bun.stringWidth(strip(row))).toBeLessThanOrEqual(12);
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
    expect(calls.absorb([{ result: { id: "a", ok: true, text: "x\ny" } }])).toEqual([{ tool: "bash(ls)", summary: "2 lines", failed: false, kind: "tool", items: [] }]);
    expect(calls.size).toBe(0);
    expect(calls.absorb([{ result: { id: "zz", ok: false, text: "boom" } }])).toEqual([{ tool: "tool()", summary: "boom", failed: true, kind: "tool", items: [] }]);
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
  expect(calls.interrupt()).toEqual([{ tool: "bash(sleep 99)", summary: "interrupted", failed: true, kind: "tool", items: [] }]);
  expect(calls.size).toBe(0);
});
