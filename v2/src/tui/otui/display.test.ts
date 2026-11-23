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
