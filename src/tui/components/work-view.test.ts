import { expect, test } from "bun:test";
import { findItem, inputLine, renderWorkPage, tableRows, withArchiveSection, type WorkPage, type WorkRow } from "./work-view";
import { plainText, visibleLength } from "./text";

const items: WorkRow[] = Array.from({ length: 14 }, (_, i) => ({ id: `id-${i}`, name: i === 7 ? "Memory backfill redo PR 3: run buttons on the backfill tab" : `Item ${i}`,
  status: i % 2 ? "pr open" : "merged", color: 32, info: `PR #${200 + i}` }));
const page = (over: Partial<WorkPage> = {}): WorkPage => ({ cols: 104, rows: 27, tabs: [{ name: "Agents", count: 5 }, { name: "Tasks", count: 14 }, { name: "Questions", count: 3 }, { name: "Images" }, { name: "Projects", count: 5 }],
  active: 1, items, selected: 7, empty: "No tasks", sections: [{ title: "Summary", text: "Stacked on redo PR 2. " + "Adds a confirm step. ".repeat(12) }, { title: "Pull request", fields: [["link", "PR #207", "https://example.test/207"], ["checks", "2 pending"]] }], footer: "j/k move · esc close", ...over });
const text = (p: WorkPage) => renderWorkPage(p).lines.map(plainText);

test("table over detail: tabs with counts and position, header, a third of the rows as table, a rule naming the selection, sections, the status line last", () => {
  const out = renderWorkPage(page()), lines = out.lines.map(plainText);
  expect(lines).toHaveLength(27);
  expect(lines[0]).toMatch(/^Agents 5 {3}Tasks 14 {3}Questions 3 {3}Images {3}Projects 5 +8 of 14$/);
  expect(out.lines[0]).toContain("\x1b[1;4mTasks\x1b[0m"); // the active tab is emphasised
  expect(lines[1]).toBe("");
  expect(lines[2]).toMatch(/^ {2}NAME +STATUS +INFO$/);
  expect(out.table).toEqual({ y: 3, top: 3, rows: 9 });
  expect(lines.slice(3, 12).filter(line => line.startsWith("› "))).toEqual([lines[7]!]);
  expect(lines[7]).toMatch(/^› Memory backfill redo PR 3: run buttons on the backfill tab +pr open +PR #207$/);
  expect(lines[12]).toMatch(/^── Memory backfill redo PR 3: run buttons on the backfill tab ─+$/);
  expect(lines[14]).toBe("  Summary");
  expect(lines.join("\n")).toContain("  link    PR #207");
  expect(out.lines.join("\n")).toContain("\x1b]8;;https://example.test/207\x1b\\PR #207\x1b]8;;\x1b\\");
  expect(lines.at(-1)).toBe("j/k move · esc close");
  expect(tableRows(27)).toBe(9); expect(tableRows(60)).toBe(20); expect(tableRows(9)).toBe(3);
});

test("no row exceeds cols at any size; INFO goes first, STATUS shortens, tiny screens keep table and status line", () => {
  for (const cols of [1, 2, 5, 12, 23, 30, 43, 59, 60, 80, 104, 200]) for (const rows of [0, 1, 2, 3, 5, 8, 9, 13, 14, 27, 60]) {
    const out = renderWorkPage(page({ cols, rows, footer: "x".repeat(300) }));
    expect(out.lines).toHaveLength(rows);
    for (const line of out.lines) expect(visibleLength(line)).toBeLessThanOrEqual(cols);
  }
  expect(text(page({ cols: 59 }))[2]).toMatch(/^ {2}NAME +STATUS *$/);
  expect(text(page({ cols: 59 }))[7]).toMatch(/pr open *$/);
  expect(text(page({ cols: 30 }))[7]).toMatch(/ pr open *$/);
  expect(text(page({ cols: 20 }))[2]!.trimEnd()).toBe("  NAME");
  const tiny = text(page({ rows: 5, cols: 40 }));
  expect(tiny[0]).toContain("Tasks"); expect(tiny.filter(line => line.startsWith("› "))).toHaveLength(1); expect(tiny.at(-1)).toBe("j/k move · esc close");
  expect(text(page({ rows: 1 }))).toEqual(["j/k move · esc close"]);
  expect(text(page({ cols: 40 }))[0]).toMatch(/Tasks/); // the active tab survives when the tab line cannot
});

test("the table scrolls to keep the selection in view; an empty tab says so", () => {
  expect(renderWorkPage(page({ selected: 0 })).table.top).toBe(0);
  expect(renderWorkPage(page({ selected: 13 })).table.top).toBe(5);
  expect(text(page({ selected: 13 }))[11]).toMatch(/^› Item 13/);
  const empty = text(page({ items: [], selected: 0, sections: [] }));
  expect(empty[3]).toBe("  No tasks"); expect(empty[0]).not.toContain(" of ");
});

test("find marks the match in the row; findItem wraps both ways and is case-insensitive", () => {
  const out = renderWorkPage(page({ query: "BACKFILL" }));
  expect(out.lines[7]).toContain("\x1b[7mbackfill\x1b[27m");
  expect(findItem(items, "item 1", 0)).toBe(1);
  expect(findItem(items, "item 1", 2)).toBe(10);
  expect(findItem(items, "item 1", 0, -1)).toBe(13);
  expect(findItem(items, "nothing", 0)).toBe(-1); expect(findItem(items, "", 0)).toBe(-1);
});

test("options are numbered rows with a cursor and the default marked; long options wrap; the cursor stays in view", () => {
  const long = "Yes, remove it; keep old reviewer transcripts readable and say so in the release note ".repeat(2).trim();
  const options = { items: [long, "Keep the role", "Not now", "Other…"], cursor: 3, default: 1 };
  const lines = text(page({ rows: 12, cols: 60, sections: [{ title: "Question", text: "Remove the role? ".repeat(20) }, { title: "Options", options }] }));
  expect(lines.some(line => line.startsWith("  › 4  Other…"))).toBe(true);
  const wide = text(page({ sections: [{ title: "Options", options: { ...options, cursor: 0 } }] }));
  const first = wide.findIndex(line => line.startsWith("  › 1  Yes, remove it"));
  expect(first).toBeGreaterThan(0); expect(wide[first + 1]).toMatch(/^ {7}\S/); // a wrapped option hangs under its text
  expect(wide.join("\n")).toContain("    2  Keep the role   default");
  expect(text(page({ sections: [{ title: "Options", options: { items: ["a"] } }] })).some(line => line.startsWith("  ›"))).toBe(false);
});

test("the input line shows the text around the cursor and where the cursor is", () => {
  expect(inputLine("find › ", "back", 4, "enter keep", 60)).toMatchObject({ col: 11 });
  expect(plainText(inputLine("find › ", "back", 4, "enter keep · esc cancel", 60).line)).toBe("find › back   enter keep · esc cancel");
  const long = inputLine("answer › ", "x".repeat(300), 300, "enter send", 40);
  expect(visibleLength(long.line)).toBeLessThanOrEqual(40); expect(long.col).toBeLessThan(40);
  expect(plainText(inputLine("answer › ", "one\ntwo", 7, "", 40).line)).toBe("answer › one↵two");
});

test("archived items fold under one selectable row", () => {
  const rows = [{ id: "a", name: "A" }, { id: "b", name: "B", archived: true }];
  expect(withArchiveSection(rows, false).map(row => row.name)).toEqual(["A", "▸ Archived (1)"]);
  expect(withArchiveSection(rows, true).map(row => row.name)).toEqual(["A", "▾ Archived (1)", "B"]);
  expect(withArchiveSection([rows[0]!], true)).toHaveLength(1);
});
