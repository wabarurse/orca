import { expect, test } from "bun:test";
import type { Entry } from "../transcript";
import { parts } from "../view";
import { Calls } from "./tools";
import { MarkdownStream } from "./mdstream";
import { historyRows, type Line } from "./lines";
import { restore, earlier } from "./restore";
import { commit, fit, headerRow, live, liveRows, type Frame } from "./render";
import { FakeScreen } from "./testing";

const assistant = (text: string, id: string): Entry => ({ type: "message", uuid: id, parentUuid: null, ts: "", message: { role: "assistant", content: [{ type: "text", text }] } });
const strip = (rows: string[]) => rows.map(Bun.stripANSI);

test("paragraph lines, quotes and multi-line nested lists retain message identity across chunks, restore and agents", () => {
  const texts = ["paragraph line one\nparagraph line two\n\n> quote one\n> quote two\n\n- item\n  continuation one\n  continuation two\n  - nested\n- next item", "a new assistant turn\ncontinues here"];
  const entries = texts.map((t, i) => assistant(t, String(i)));
  const md = new MarkdownStream();
  const liveLines: Line[] = [];
  const incremental: string[] = [];
  function append(lines: Line[]) {
    incremental.push(...historyRows(lines, 24, liveLines.at(-1)));
    liveLines.push(...lines);
  }
  for (const text of texts) {
    for (const char of text) append(md.feedLines(char));
    append(md.flushLines());
  }
  const expected = historyRows(liveLines, 24);
  expect(incremental).toEqual(expected);
  expect(historyRows(restore(entries, 24), 24)).toEqual(expected);
  const calls = new Calls();
  const agentLines = entries.flatMap((e) => calls.absorb(parts(e) ?? []));
  expect(historyRows(agentLines, 24)).toEqual(expected);
  const plain = strip(expected).join("\n");
  expect(plain).toContain("paragraph line one\nparagraph line two");
  expect(plain).not.toContain("continuation one\n\n");
  expect(plain).toContain("next item\n\na new assistant turn");
});

test("restore budgets actual separators and omission note, keeps whole messages and newest oversize exception", () => {
  const entries = Array.from({ length: 250 }, (_, i) => assistant(`message ${i}`, String(i)));
  const exact = restore(entries, 60, 201);
  expect(exact[0]).toBe(earlier(150));
  expect(historyRows(exact, 60).length).toBe(201);
  const tight = restore(entries, 60, 200);
  expect(tight[0]).toBe(earlier(151));
  expect(historyRows(tight, 60).length).toBe(199);
  const huge = assistant(Array.from({ length: 240 }, (_, i) => `line ${i}`).join("\n"), "huge");
  const retained = restore([...entries, huge], 60, 200);
  expect(retained[0]).toBe(earlier(250));
  expect(historyRows(retained, 60).length).toBe(242);
});

test("pending unfinished fenced text preserves interior blanks before and after commit", () => {
  const partial = "```txt\nfirst\n\nsecond\n";
  const f: Frame = { cols: 20, rows: 12, partial, input: { prompt: "> ", text: "", cursor: 0 }, menu: null };
  const rows = strip(liveRows(f).rows);
  expect(rows.slice(0, 5)).toEqual(["```txt", "first", "", "second", ""]);
  const md = new MarkdownStream();
  const lines = [...md.feedLines(partial), ...md.flushLines()];
  const rendered = strip(historyRows(lines, 20));
  expect(rendered.join("\n")).toContain("│ first\n│ \n│ second");
});

test("one-column fit, header, status and modal never overflow and erase returns to the live-region start", () => {
  expect(fit("abc", 1)).toBe("…");
  expect(fit("界", 1)).toBe("…");
  expect(fit("x", 0)).toBe("");
  const f: Frame = { cols: 1, rows: 5, status: "status", input: { prompt: "> ", text: "界", cursor: 1 }, menu: { title: "models", items: ["one"], index: 0 } };
  const s = new FakeScreen(1, 8);
  s.write(commit([headerRow("界 directory", 1)], 1));
  const first = live(f);
  s.write(first.text);
  expect(liveRows(f).rows.every((r) => Bun.stringWidth(r) <= 1)).toBe(true);
  expect(s.col).toBe(0);
  s.write(live({ ...f, menu: null, status: null, input: { prompt: "> ", text: "", cursor: 0 } }, first.shown).text);
  expect(s.screen().slice(2).every((r) => !r)).toBe(true);
});
