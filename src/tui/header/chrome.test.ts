import { expect, test } from "bun:test";
import { chapterRows, tabRow, headerHeight, type Chapter } from "./chrome";
import { commit, statusRows } from "../footer/render";
import { toolRows, runningRow } from "../conversation/tools";
import { FakeScreen } from "../components/testing";
import { whaleRows } from "./whale";

const plain = (rows: string[]) => rows.map(Bun.stripANSI);
const chapter: Chapter = { tabs: [{ name: "orch-one" }, { name: "orch-two" }], active: 1, model: "model-a" };
const counts = "2 agents running │ 1 task │ 3 questions";

test("the header is a box open at the top: plain tabs, then the models in dim with the context at the right, then its bottom line", () => {
  const rows = chapterRows({ ...chapter, context: "ctx ~3.9k/1M" }, 80);
  expect(plain(rows)).toEqual([
    "│ orch-one   orch-two" + " ".repeat(57) + " │",
    "│ model-a" + " ".repeat(57) + "ctx ~3.9k/1M │",
    "└" + "─".repeat(78) + "┘",
  ]);
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
    expect(rows.length).toBeLessThanOrEqual(3);
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

test("the header keeps to its budget: the box needs three rows, else the tabs and then the details row", () => {
  const c = { ...chapter, model: "model-a · effort high · fast" };
  expect(chapterRows(c, 40, 0)).toEqual([]);
  expect(plain(chapterRows(c, 40, 1))).toEqual(["orch-one   orch-two"]);
  expect(plain(chapterRows(c, 40, 2))).toEqual(["orch-one   orch-two", "model-a · effort high · fast"]);
  expect(plain(chapterRows(c, 40, 3))).toEqual(["│ orch-one   orch-two" + " ".repeat(17) + " │", "│ model-a · effort high · fast" + " ".repeat(8) + " │", "└" + "─".repeat(38) + "┘"]);
  for (const rows of [2, 3, 6, 12, 24, 50]) expect(chapterRows(c, 40, headerHeight(rows)).length).toBeLessThanOrEqual(Math.max(0, headerHeight(rows)));
});

test("the details row leads with the account and clips its tail; the context stays whole at its right", () => {
  const roles = "orch gpt-6-astra · workers claude-sonnet-5-5 · reviewers claude-haiku-5-5 · effort high";
  const c: Chapter = { ...chapter, account: "openai:phoebe", model: roles, context: "ctx 112k/272k" };
  const wide = plain(chapterRows(c, 200));
  expect(wide[1]).toStartWith(`│ openai:phoebe · ${roles} `);
  expect(wide[1]).toEndWith(" ctx 112k/272k │");
  const narrow = plain(chapterRows(c, 80));
  expect(narrow[1]).toBe("│ openai:phoebe · orch gpt-6-astra · workers claude-sonnet-5-5…  ctx 112k/272k │");
  expect(narrow.every(row => Bun.stringWidth(row) === 80)).toBe(true);
  expect(plain(chapterRows({ ...c, agent: "worker-feat" }, 120))[1]).toStartWith("│ view worker-feat · openai:phoebe");
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
