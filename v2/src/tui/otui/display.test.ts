import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { screens } from "../components";
import { Display } from "./display";

const chat = (rows: string[]): screens.ChatScreen => ({ kind: "chat", header: null, items: [{ kind: "rows", key: "r", gap: false, rows }], tail: [], welcome: [], footer: ["› "], cursor: null });

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

test("at the bottom new content keeps the view at the bottom; scrolled up, new content and streaming leave it in place", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  const rows = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  display.show(chat(rows));
  await setup.renderOnce();
  display.show(chat([...rows, "line 30"]));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 30");

  display.scroll("page-up");
  display.scroll("page-up");
  await setup.renderOnce();
  const before = setup.captureCharFrame();
  display.show(chat([...rows, "line 30", "line 31"]));
  await setup.renderOnce();
  display.show({ ...chat([...rows, "line 30", "line 31"]), tail: ["streaming"] });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toBe(before);
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

test("expanding keeps the message in place, and for 5 s after a scroll nothing moves the view until a change brings it back to the bottom", async () => {
  const setup = await createTestRenderer({ width: 40, height: 14 });
  let now = 0, open = false, extra: string[] = [];
  const show = (): void => {
    const user: screens.ScreenItem = { kind: "user", key: "u", gap: false, rows: open ? ["u0", "u1", "u2", "u3", "u4"] : ["u0"], fill: null, open, more: 4 };
    display.show({ ...chat([]), items: [{ kind: "rows", key: "a", gap: false, rows: Array.from({ length: 30 }, (_, i) => `line ${i}`) }, user, { kind: "rows", key: "b", gap: false, rows: extra }] });
  };
  const display = new Display(setup.renderer, action => { if (action.kind === "toggle") { open = !open; show(); } }, () => {}, () => now);
  const row = (text: string): number => setup.captureCharFrame().split("\n").findIndex(line => line.includes(text));
  show();
  await setup.renderOnce();
  const top = row("u0"), toggle = row("more lines");
  expect(toggle).toBeGreaterThan(top);
  await setup.mockMouse.click((setup.captureCharFrame().split("\n")[toggle] ?? "").indexOf("more"), toggle);
  await setup.renderOnce();
  expect(row("u0")).toBe(top);

  now = 1000;
  display.scroll("up");
  display.scroll("down");
  await setup.renderOnce();
  const held = setup.captureCharFrame();
  now = 5999;
  extra = ["new 1"];
  show();
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toBe(held);
  now = 6000;
  extra = ["new 1", "new 2"];
  show();
  await setup.renderOnce();
  expect(row("new 2")).toBeGreaterThan(0);
  await setup.dispose();
});
