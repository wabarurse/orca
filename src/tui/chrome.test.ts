import { expect, test } from "bun:test";
import { chapterRows, tabRow, headerHeight, type Chapter } from "./chrome";
import { commit, statusRows } from "./render";
import { toolRows, runningRow } from "./tools";
import { FakeScreen } from "./testing";
import { whaleRows } from "./whale";

const plain = (rows: string[]) => rows.map(Bun.stripANSI);
const chapter: Chapter = { tabs: [{ name: "orch-one" }, { name: "orch-two" }], active: 1, model: "model-a", directory: "/repo", remote: "host/repo" };
const counts = "2 agents running │ 1 message queued │ 3 questions";

test("chapter rules lead with real bracketed pages, selected in text and intensity; no branding or hints", () => {
  const rows = chapterRows(chapter, 80);
  expect(plain(rows)).toEqual(["── [orch-one] >[orch-two] " + "─".repeat(54), "model model-a", "/repo", "host/repo", "─".repeat(80)]);
  expect(rows[0]).toContain("\x1b[1m>[orch-two]");
  expect(rows.join("")).not.toMatch(/orca|Ctrl\+|48;/);
  const s = new FakeScreen(80, 24);
  s.write(commit(rows, 80));
  expect(s.backgrounds().every((row) => row.every((cell) => !cell))).toBe(true);
});

test("many pages window around first, middle and last active page, with omission markers", () => {
  const tabs = Array.from({ length: 100 }, (_, n) => ({ name: `orch-${n}` }));
  for (const active of [0, 1, 50, 98, 99]) {
    const row = Bun.stripANSI(tabRow(tabs, active, 40));
    expect(row).toContain(`>[orch-${active}]`);
    expect(row).toContain("…");
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
    const visible = [...row.matchAll(/orch-(\d+)/g)].map((m) => Number(m[1]));
    expect(visible).toEqual([...visible].sort((a, b) => a - b));
  }
});

test("Unicode names and long model/path/remote are bounded in true cells, not bytes; unsafe metadata is inert", () => {
  for (const cols of [1, 2, 3, 4, 6, 10, 20, 80, 160]) {
    const c: Chapter = { ...chapter, tabs: [{ name: "old" }, { name: "界é👨‍👩‍👧‍👦".repeat(100) + "\x1b[2J\n" }], model: "模型".repeat(100), directory: "/long/".repeat(100), remote: "host/".repeat(100) };
    const rows = chapterRows(c, cols);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
    expect(Bun.stripANSI(rows[0]!)).toContain(">");
    expect(rows.join("")).not.toContain("\x1b[2J");
    new FakeScreen(cols, 12).write(commit(rows, cols));
  }
});

test("count strip groups on wide screens and stacks on narrow screens, without shortcuts or metadata", () => {
  expect(plain(statusRows(counts, 80, 24))).toEqual([counts]);
  expect(plain(statusRows(counts, 20, 24))).toEqual(["2 agents running", "1 message queued", "3 questions"]);
  expect(statusRows(counts, 80, 2)).toEqual([]);
});

test("tool history and running labels also obey one-cell and Unicode limits", () => {
  for (const cols of [1, 2, 3, 5, 8]) {
    const rows = [...toolRows({ tool: "bash(界界)", summary: "界界".repeat(10), failed: true }, cols), runningRow({ name: "bash", input: { command: "界".repeat(40) } }, 400, cols)];
    expect(rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
  }
});

test("bounded header budgets retain each field before wrapping long metadata", () => {
  const c = { ...chapter, model: "model-a · effort high · fast on", directory: "/long".repeat(100), remote: "host/repo".repeat(100) };
  for (const rows of [1, 2, 3, 6, 12, 15, 18, 24, 50]) {
    const budget = headerHeight(rows);
    const header = plain(chapterRows(c, 40, budget));
    expect(header.length).toBeLessThanOrEqual(budget);
    if (budget >= 5) {
      expect(header[1]).toContain("effort high · fast on");
      expect(header.join("\n")).toContain("/long");
      expect(header.join("\n")).toContain("host/repo");
      expect(header.at(-1)).toBe("─".repeat(40));
    }
  }
});

test("whale fits beside metadata at ordinary sizes and falls back safely on tiny terminals", () => {
  for (const cols of [1, 20, 40, 68, 80, 100, 160]) for (const rows of [6, 12, 24, 36, 60, 90]) {
    const budget = headerHeight(rows);
    const c = { ...chapter, context: "24k / 272k", review: "review 1", dispatch: "dispatch off", whale: { time: 1200, active: true } };
    const header = plain(chapterRows(c, cols, budget));
    expect(header.length).toBeLessThanOrEqual(budget);
    expect(header.every(line => Bun.stringWidth(line) <= cols)).toBe(true);
    if (cols >= 80 && rows >= 24) {
      expect(header.join("\n")).toContain("orca");
      expect(header.join("\n")).toContain("model model-a");
      expect(header.join("\n")).toContain("host/repo");
      expect(header.join("\n")).toContain(">[orch-two]");
    }
  }
});

test("whale animation only changes the tail and stays still when idle", () => {
  for (const [cols, budget] of [[32, 6], [44, 10], [84, 19]]) {
    const a = whaleRows(cols!, budget!, 0, true), b = whaleRows(cols!, budget!, 1200, true);
    expect(a.slice(0, -2)).toEqual(b.slice(0, -2));
    expect(a).not.toEqual(b);
    expect(whaleRows(cols!, budget!, 0, false)).toEqual(whaleRows(cols!, budget!, 1200, false));
    expect(b.every(row => row.length === cols && /^[ -~]+$/.test(row))).toBe(true);
  }
});
