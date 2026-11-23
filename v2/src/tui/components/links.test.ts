import { expect, test } from "bun:test";
import { linkAt, linkSpanAt, underlineSpan } from "./links";

const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("a link's span is found for written-out addresses and OSC 8 links, and only openable ones count", () => {
  const bare = "see https://example.com/docs. then";
  expect(linkSpanAt(bare, 6)).toEqual({ url: "https://example.com/docs", start: 4, end: 28 });
  expect(linkSpanAt(bare, 2)).toBeUndefined();
  const named = `PR ${osc8("https://github.com/o/r/pull/7", "#7")} open`;
  expect(linkSpanAt(named, 3)).toEqual({ url: "https://github.com/o/r/pull/7", start: 3, end: 5 });
  expect(linkAt(named, 6)).toBeUndefined();
  expect(linkAt(osc8("javascript:alert(1)", "click"), 1)).toBeUndefined();
});

test("underlining a span wraps exactly its cells, and keeps it underlined across colour changes inside it", () => {
  const row = "go \x1b[36mhttps://a.io\x1b[0m now";
  const span = linkSpanAt(row, 5);
  expect(span).toEqual({ url: "https://a.io", start: 3, end: 15 });
  if (span === undefined) return;
  const out = underlineSpan(row, span);
  expect(Bun.stripANSI(out)).toBe(Bun.stripANSI(row));
  expect(out).toBe("go \x1b[36m\x1b[4mhttps://a.io\x1b[0m\x1b[4m\x1b[24m now");
});
