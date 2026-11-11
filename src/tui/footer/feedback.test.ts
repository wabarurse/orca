import { expect, test } from "bun:test";
import { InputFeedback, compactedNotice } from "./feedback";

test("reusable feedback scopes content and separates persistent loading from ephemeral notices", () => {
  const area = new InputFeedback<object>(), first = {}, second = {};
  area.set(first, "operation", { content: "Loading…", loading: true, lifetime: "persistent" });
  area.set(first, "result", { content: ["First line", "Second line"], lifetime: "ephemeral" });
  area.set(second, "other", { content: "Another conversation", lifetime: "ephemeral" });
  const rows = area.rows(first, 50, 0).map(Bun.stripANSI);
  expect(rows).toEqual(["First line", "Second line", "⠋ Loading…"]);
  expect(area.rows(first, 50, 120)).not.toEqual(area.rows(first, 50, 0));
  area.dismiss(first);
  expect(area.rows(first, 50, 0).map(Bun.stripANSI)).toEqual(["⠋ Loading…"]);
  expect(area.rows(second, 50, 0).map(Bun.stripANSI)).toEqual(["Another conversation"]);
  expect(area.rows(first, 4, 0).every(row => Bun.stringWidth(row) <= 4)).toBe(true);
  expect(area.rows(first, 50, 0, 0)).toEqual([]);
  area.remove(first, "operation"); expect(area.rows(first, 50, 0)).toEqual([]);
  area.set(undefined, "initial", { content: "Startup notice", lifetime: "ephemeral" });
  area.move(undefined, first); expect(area.rows(undefined, 50, 0)).toEqual([]);
  expect(area.rows(first, 50, 0).map(Bun.stripANSI)).toEqual(["Startup notice"]);
});

test("compaction completion uses compact token counts without altering failures", () => {
  expect(compactedNotice("compaction complete: ~302194 → ~65368 history tokens; recent messages unchanged.")).toBe("Compacted 302k → 65k");
  expect(compactedNotice("compaction failed: provider unavailable")).toBe("compaction failed: provider unavailable");
});
