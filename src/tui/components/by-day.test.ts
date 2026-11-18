import { expect, test } from "bun:test";
import { byDay, foldHeadings, renderWorkPage, type WorkRow } from "./work-view";

test("rows are listed newest first under a heading per local day; an unknown time goes last under Earlier", () => {
  const now = new Date(2026, 0, 10, 15).getTime(), at = (day: number, hour: number) => new Date(2026, 0, day, hour).getTime();
  const rows: (WorkRow & { ms: number })[] = [{ id: "a", name: "a", ms: at(9, 8) }, { id: "b", name: "b", ms: at(10, 9) }, { id: "c", name: "c", ms: NaN }, { id: "d", name: "d", ms: at(10, 14) }, { id: "e", name: "e", ms: at(3, 1) }, { id: "f", name: "f", ms: at(10, 9) }];
  const out = byDay(rows, row => row.ms, now);
  expect(out.map(row => row.heading ? `[${row.name}]` : row.name)).toEqual(["[Today]", "d", "b", "f", "[Yesterday]", "a", "[Jan 3, 2026]", "e", "[Earlier]", "c"]);
  expect(out.filter(row => row.heading).map(row => row.id)).toEqual([":day:2026-01-10", ":day:2026-01-09", ":day:2026-01-03", ":day:unknown"]);
  expect(byDay([], () => 0, now)).toEqual([]);
});

test("a heading folds its rows away and keeps their count; a group ends at the next heading or the Archived row", () => {
  const rows: (WorkRow & { section?: true })[] = [{ id: ":day:1", name: "Today", heading: true }, { id: "a", name: "a" }, { id: "b", name: "b" },
    { id: ":day:2", name: "Yesterday", heading: true }, { id: "c", name: "c" }, { id: ":archived", name: "▸ Archived (1)", section: true }, { id: "z", name: "z" }];
  const names = (folded: string[]) => foldHeadings(rows, new Set(folded)).map(row => row.name);
  expect(names([])).toEqual(["▾ Today (2)", "a", "b", "▾ Yesterday (1)", "c", "▸ Archived (1)", "z"]);
  expect(names([":day:1"])).toEqual(["▸ Today (2)", "▾ Yesterday (1)", "c", "▸ Archived (1)", "z"]);
  expect(names([":day:2"])).toEqual(["▾ Today (2)", "a", "b", "▸ Yesterday (1)", "▸ Archived (1)", "z"]); // archived rows are not the day's
});

test("a heading is drawn bold with a rule to the edge of the row", () => {
  const items = foldHeadings<WorkRow>([{ id: ":day:1", name: "Today", heading: true }, { id: "a", name: "a", status: "running" }], new Set());
  const page = renderWorkPage({ cols: 30, rows: 12, tabs: [{ name: "Agents" }], active: 0, items, selected: 1, empty: "", sections: [], footer: "" });
  expect(page.lines[page.table.y]).toBe("  \x1b[1m▾ Today (1)\x1b[0m \x1b[2m" + "─".repeat(16) + "\x1b[0m");
});
