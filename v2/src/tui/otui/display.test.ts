import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { screens } from "../components";
import { Display } from "./display";

const chat = (rows: string[]): screens.ChatScreen => ({ kind: "chat", header: null, view: "a", items: [{ kind: "rows", key: "r", gap: false, rows }], tail: [], welcome: [], footer: ["› "], cursor: null });

test("hovering a link underlines it, clicking it asks to open it, and a finished drag selection asks to copy", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 });
  const actions: screens.ScreenAction[] = [];
  const display = new Display(setup.renderer, action => { actions.push(action); }, () => {});
  display.show(chat(["read https://example.com/docs first", "plain words here"]));
  await setup.renderOnce();
  const frame = setup.captureCharFrame().split("\n");
  const y = frame.findIndex(line => line.includes("https://example.com"));
  const x = (frame[y] ?? "").indexOf("example");
  expect(y).toBeGreaterThanOrEqual(0);
  const underlined = (): string => setup.captureSpans().lines.flatMap(l => l.spans).filter(s => (s.attributes & TextAttributes.UNDERLINE) !== 0).map(s => s.text).join("");
  expect(underlined()).toBe("");

  await setup.mockMouse.moveTo(x, y);
  await setup.renderOnce();
  expect(underlined()).toBe("https://example.com/docs");
  await setup.mockMouse.moveTo(2, y + 1);
  await setup.renderOnce();
  expect(underlined()).toBe("");

  await setup.mockMouse.click(x, y);
  expect(actions).toContainEqual({ kind: "link", url: "https://example.com/docs" });

  const words = y + 1, from = (frame[words] ?? "").indexOf("plain");
  await setup.mockMouse.drag(from, words, from + 4, words);
  await setup.renderOnce();
  expect(actions.filter(a => a.kind === "copy")).toEqual([{ kind: "copy", text: "plain" }]);
  await setup.dispose();
});

const items = (count: number, tall = -1): screens.ScreenItem[] => Array.from({ length: count }, (_, i) => ({ kind: "rows", key: `i${i}`, gap: false, rows: i === tall ? [`line ${i}`, `extra ${i}`] : [`line ${i}`] }));
const listed = (list: screens.ScreenItem[], view = "a"): screens.ChatScreen => ({ ...chat([]), view, items: list });
const rowOf = (frame: string, text: string): number => frame.split("\n").findIndex(line => line.includes(text));

test("at the bottom new items and the streaming tail keep the view following the bottom", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  display.show(listed(items(30)));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 29");
  display.show(listed(items(32)));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 31");
  display.show({ ...listed(items(32)), tail: ["streaming"] });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("streaming");
  expect(setup.captureCharFrame()).not.toContain("below");
  await setup.dispose();
});

test("after scrolling up new items and streaming do not move the view, and a hint counts the rows below", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  display.show(listed(items(30)));
  await setup.renderOnce();
  display.scroll("page-up");
  display.scroll("page-up");
  await setup.renderOnce();
  const before = rowOf(setup.captureCharFrame(), "line 15");
  expect(before).toBeGreaterThanOrEqual(0);
  display.show(listed(items(31)));
  await setup.renderOnce();
  display.show({ ...listed(items(31)), tail: ["streaming", "more streaming"] });
  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(rowOf(frame, "line 15")).toBe(before);
  expect(frame).not.toContain("line 30");
  expect(frame).toMatch(/↓ \d+ more lines below/);
  await setup.dispose();
});

test("a rebuilt item above the reading point keeps the line being read in place", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  display.show(listed(items(30)));
  await setup.renderOnce();
  display.scroll("page-up");
  display.scroll("page-up");
  await setup.renderOnce();
  const before = rowOf(setup.captureCharFrame(), "line 15");
  display.show(listed(items(30, 2)));
  await setup.renderOnce();
  await setup.renderOnce();
  expect(rowOf(setup.captureCharFrame(), "line 15")).toBe(before);
  await setup.dispose();
});

test("End, Page Down to the bottom and a click on the hint resume following", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  display.show(listed(items(30)));
  await setup.renderOnce();
  display.scroll("page-up");
  await setup.renderOnce();
  display.scroll("end");
  display.show(listed(items(31)));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 30");

  display.scroll("page-up");
  await setup.renderOnce();
  display.scroll("page-down");
  display.show(listed(items(32)));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 31");

  display.scroll("up");
  display.scroll("up");
  display.scroll("up");
  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  const y = rowOf(frame, "below");
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click((frame.split("\n")[y] ?? "").indexOf("below"), y);
  display.show(listed(items(33)));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 32");
  await setup.dispose();
});

test("each view keeps its own place: a new view opens at the bottom and a scrolled one comes back where it was", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  display.show(listed(items(30), "a"));
  await setup.renderOnce();
  display.scroll("page-up");
  display.scroll("page-up");
  await setup.renderOnce();
  const before = rowOf(setup.captureCharFrame(), "line 15");
  display.show(listed(items(40), "b"));
  await setup.renderOnce();
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 39");
  display.show(listed(items(30), "a"));
  await setup.renderOnce();
  await setup.renderOnce();
  expect(rowOf(setup.captureCharFrame(), "line 15")).toBe(before);
  display.show(listed(items(40), "b"));
  await setup.renderOnce();
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 39");
  await setup.dispose();
});

test("a capped user message has a row that asks to open it", async () => {
  const setup = await createTestRenderer({ width: 60, height: 30 });
  const actions: screens.ScreenAction[] = [];
  const display = new Display(setup.renderer, action => { actions.push(action); }, () => {});
  const user: screens.ScreenItem = { kind: "user", key: "p-0", gap: false, rows: ["first", "second"], fill: null, open: false, more: 7 };
  display.show({ ...chat([]), items: [user] });
  await setup.renderOnce();
  const frame = setup.captureCharFrame().split("\n");
  const y = frame.findIndex(line => line.includes("7 more lines"));
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click((frame[y] ?? "").indexOf("7 more"), y);
  expect(actions).toContainEqual({ kind: "toggle", key: "p-0" });
  display.show({ ...chat([]), items: [{ ...user, open: true }] });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("show less");
  await setup.dispose();
});
