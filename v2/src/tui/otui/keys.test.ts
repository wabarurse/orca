import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { keyFrom } from "./keys";

test("byte 8 is Ctrl+H and Ctrl+L stays Ctrl+L; Backspace (127) is still backspace", () => {
  const key = (raw: string) => { const event = parseKeypress(raw); return event === null ? null : keyFrom(new KeyEvent(event)); };
  expect(key("\x08")).toEqual({ name: "h", ctrl: true });
  expect(key("\x0c")).toEqual({ name: "l", ctrl: true });
  expect(key("\x7f")).toEqual({ name: "backspace" });
});

test("Option, Ctrl and Cmd (kitty super) arrows, Option+Backspace and Cmd+A decode with their modifiers", () => {
  const key = (raw: string) => { const event = parseKeypress(raw, { useKittyKeyboard: true }); return event === null ? null : keyFrom(new KeyEvent(event)); };
  expect(key("\x1bb")).toEqual({ name: "b", alt: true });
  expect(key("\x1bf")).toEqual({ name: "f", alt: true });
  expect(key("\x1b[1;3D")).toEqual({ name: "left", alt: true });
  expect(key("\x1b[1;5C")).toEqual({ name: "right", ctrl: true });
  expect(key("\x1b[1;4D")).toEqual({ name: "left", alt: true, shift: true });
  expect(key("\x1b[1;9D")).toEqual({ name: "left", cmd: true });
  expect(key("\x1b[1;10C")).toEqual({ name: "right", shift: true, cmd: true });
  expect(key("\x1b\x7f")).toEqual({ name: "backspace", alt: true });
  expect(key("\x1b[3;3~")).toEqual({ name: "delete", alt: true });
  expect(key("\x1b[127;9u")).toEqual({ name: "backspace", cmd: true });
  expect(key("\x1b[97;9u")).toEqual({ name: "a", cmd: true });
  expect(key("\x1b[122;10u")).toEqual({ name: "z", shift: true, cmd: true });
  expect(key("\x05")).toEqual({ name: "e", ctrl: true });
});
