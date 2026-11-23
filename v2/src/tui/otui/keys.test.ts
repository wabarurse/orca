import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { keyFrom } from "./keys";

test("byte 8 is Ctrl+H and Ctrl+L stays Ctrl+L; Backspace (127) is still backspace", () => {
  const key = (raw: string) => { const event = parseKeypress(raw); return event === null ? null : keyFrom(new KeyEvent(event)); };
  expect(key("\x08")).toEqual({ name: "h", ctrl: true });
  expect(key("\x0c")).toEqual({ name: "l", ctrl: true });
  expect(key("\x7f")).toEqual({ name: "backspace" });
});
