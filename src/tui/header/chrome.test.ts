import { expect, test } from "bun:test";
import { chapterRows, tabRow, headerHeight, type Chapter } from "./chrome";
import { commit, statusRows } from "../footer/render";
import { toolRows, runningRow } from "../conversation/tools";
import { FakeScreen } from "../components/testing";
import { whaleRows } from "./whale";

const plain = (rows: string[]) => rows.map(Bun.stripANSI);
const chapter: Chapter = { tabs: [{ name: "orch-one" }, { name: "orch-two" }], active: 1, model: "model-a" };
const counts = "2 agents running │ 1 task │ 3 questions";

test("the header is one ruled row: plain tabs, the selected one bold, then a blank; no branding or hints", () => {
  const rows = chapterRows(chapter, 80);
  expect(plain(rows)).toEqual(["── orch-one   orch-two " + "─".repeat(46) + " model-a ──", ""]);
  expect(rows[0]).toContain("\x1b[1morch-two");
  expect(rows.join("")).not.toMatch(/orca|Ctrl\+|48;/);
  const s = new FakeScreen(80, 24);
  s.write(commit(rows, 80));
  expect(s.backgrounds().every((row) => row.every((cell) => !cell))).toBe(true);
});

test("many pages window around first, middle and last active page, with omission markers", () => {
  const tabs = Array.from({ length: 100 }, (_, n) => ({ name: `orch-${n}` }));
  for (const active of [0, 1, 50, 98, 99]) {
    const styled = tabRow(tabs, active, 40), row = Bun.stripANSI(styled);
    expect(styled).toContain(`\x1b[1morch-${active}`);
    expect(row).toContain("…");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
    const visible = [...row.matchAll(/orch-(\d+)/g)].map((m) => Number(m[1]));
    expect(visible).toEqual([...visible].sort((a, b) => a - b));
  }
});

test("Unicode names and a long model are bounded in true cells, not bytes; unsafe metadata is inert", () => {
  for (const cols of [1, 2, 3, 4, 6, 10, 20, 80, 160]) {
    const c: Chapter = { ...chapter, tabs: [{ name: "old" }, { name: "界é👨‍👩‍👧‍👦".repeat(100) + "\x1b[2J\n" }], model: "模型".repeat(100) };
    const rows = chapterRows(c, cols);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
    expect(rows.join("")).not.toContain("\x1b[2J");
    new FakeScreen(cols, 12).write(commit(rows, cols));
  }
});

test("count strip groups on wide screens and stacks on narrow screens, without shortcuts or metadata", () => {
  expect(plain(statusRows(counts, 80, 24))).toEqual([counts]);
  expect(plain(statusRows(counts, 20, 24))).toEqual(["2 agents running", "1 task │ 3 questions"]);
  expect(plain(statusRows(counts, 16, 24))).toEqual(["2 agents running", "1 task", "3 questions"]);
  expect(statusRows(counts, 80, 2)).toEqual([]);
});

test("tool history and running labels also obey one-cell and Unicode limits", () => {
  for (const cols of [1, 2, 3, 5, 8]) {
    const rows = [...toolRows({ tool: "bash(界界)", summary: "界界".repeat(10), failed: true }, cols), runningRow({ name: "bash", input: { command: "界".repeat(40) } }, 400, cols)];
    expect(rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
  }
});

test("the header keeps to its budget: the ruled row first, then its blank", () => {
  const c = { ...chapter, model: "model-a · effort high · fast" };
  expect(chapterRows(c, 40, 0)).toEqual([]);
  expect(plain(chapterRows(c, 40, 1))).toEqual(["── orch-one   orch-two ─ model-a · e… ──"]);
  for (const rows of [2, 3, 6, 12, 24, 50]) expect(chapterRows(c, 40, headerHeight(rows)).length).toBeLessThanOrEqual(Math.max(0, headerHeight(rows)));
});

test("the account leads the right side; a narrow width clips the tail, keeping the account and the orchestrator's model", () => {
  const roles = "orch claude-opus-5-5 · workers claude-sonnet-5 · reviewers claude-haiku-5-5 · effort high";
  const c: Chapter = { ...chapter, account: "anthropic:phoebe", model: roles, context: "ctx 41% · 82k / 200k" };
  expect(plain(chapterRows(c, 200))[0]).toEndWith(` anthropic:phoebe · ${roles} · ctx 41% · 82k / 200k ──`);
  expect(plain(chapterRows({ ...chapter, model: roles }, 160))[0]).toEndWith(` ${roles} ──`);
  const narrow = plain(chapterRows(c, 80))[0]!;
  expect(narrow).toContain("── orch-one   orch-two ─");
  expect(narrow).toContain("anthropic:phoebe · orch claude-opus-5-5");
  expect(Bun.stringWidth(narrow)).toBe(80);
  expect(plain(chapterRows({ ...c, agent: "worker-feat" }, 120))[0]).toContain("view worker-feat · anthropic:phoebe");
});

test("new-chat whale is uncaptioned and fits each supported viewport", () => {
  for (const [cols, budget] of [[32, 6], [44, 10], [84, 19]]) {
    const art = whaleRows(cols!, budget!);
    expect(art).toHaveLength(budget!);
    expect(art.every(row => row.length === cols && /^[ #,']+$/.test(row))).toBe(true);
  }
  expect(whaleRows(20, 20)).toEqual([]);
  expect(whaleRows(100, 5)).toEqual([]);
});
