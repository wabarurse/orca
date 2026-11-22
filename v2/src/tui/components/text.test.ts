import { expect, test } from "bun:test";
import { wordWrap } from "./text";

test("a lone escape that starts no sequence is wrapped as text, not looped on", () => {
  expect(wordWrap("a \x1b b", 80)).toEqual(["a \x1b b"]);
  expect(wordWrap("\x1bx", 80)).toEqual(["\x1bx"]);
  expect(wordWrap("one two\x1b three", 7).length).toBeGreaterThan(1);
});
