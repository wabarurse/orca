import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { screens } from "../components";
import { Display } from "./display";

const chat = (rows: string[]): screens.ChatScreen => ({ kind: "chat", header: null, items: [{ kind: "rows", key: "r", gap: false, rows }], tail: [], updates: 0, welcome: [], footer: ["› "], cursor: null });

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

test("any update to the chat brings it back to the bottom, even after scrolling up, but a spinner tick does not", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const display = new Display(setup.renderer, () => {}, () => {});
  const rows = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  display.show(chat(rows));
  await setup.renderOnce();
  display.scroll("page-up");
  display.scroll("page-up");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("line 29");

  display.show(chat([...rows, "line 30"]));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("line 30");

  display.scroll("page-up");
  await setup.renderOnce();
  display.show({ ...chat([...rows, "line 30"]), tail: ["streaming"], updates: 1 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("streaming");

  display.scroll("page-up");
  await setup.renderOnce();
  display.show({ ...chat([...rows, "line 30"]), tail: ["streaming ⠋ 3s"], updates: 1 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("streaming");
  await setup.dispose();
});
