import { expect, test } from "bun:test";
import { byDay } from "./work-view";

test("rows are listed newest first under a heading per local day; an unknown time goes last under Earlier", () => {
  const now = new Date(2026, 0, 10, 15).getTime(), at = (day: number, hour: number) => new Date(2026, 0, day, hour).getTime();
  const rows = [{ id: "a", name: "a", ms: at(9, 8) }, { id: "b", name: "b", ms: at(10, 9) }, { id: "c", name: "c", ms: NaN }, { id: "d", name: "d", ms: at(10, 14) }, { id: "e", name: "e", ms: at(3, 1) }, { id: "f", name: "f", ms: at(10, 9) }];
  const out = byDay(rows, row => row.ms, now);
  expect(out.map(row => row.heading ? `[${row.name}]` : row.name)).toEqual(["[Today]", "d", "b", "f", "[Yesterday]", "a", "[Jan 3, 2026]", "e", "[Earlier]", "c"]);
  expect(out.filter(row => row.heading).map(row => row.id)).toEqual([":day:2026-01-10", ":day:2026-01-09", ":day:2026-01-03", ":day:unknown"]);
  expect(byDay([], () => 0, now)).toEqual([]);
});
