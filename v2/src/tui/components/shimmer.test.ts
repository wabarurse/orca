import { expect, test } from "bun:test";
import { glow, swimming, waves, WAVE_MS } from "./shimmer";

test("the waves are a 3-character window scrolling over the pattern", () => {
  expect(waves(0)).toBe("~∽^");
  expect(waves(WAVE_MS - 1)).toBe("~∽^");
  expect(waves(WAVE_MS)).toBe("∽^∽");
  expect(waves(WAVE_MS * 7)).toBe("^~∽");
  expect(waves(WAVE_MS * 8)).toBe("~∽^");
});

test("the glow peaks where the sweep is and fades within 2.5 cells", () => {
  expect(glow(0, 12, 0)).toBe(0);
  expect(glow(6, 12, 1250)).toBe(1);
  expect(glow(7, 12, 1250)).toBeCloseTo(0.6);
  expect(glow(6, 12, 1250 + 2500 * (3 / 18))).toBe(0);
});

test("without colour it is plain text, and the waves still move", () => {
  expect(swimming("8s", 0, { NO_COLOR: "1" })).toBe("~∽^ swimming (8s)");
  expect(swimming(null, WAVE_MS, { NO_COLOR: "1" })).toBe("∽^∽ swimming");
  expect(Bun.stripANSI(swimming("8s", 0, { COLORTERM: "truecolor" }))).toBe("~∽^ swimming (8s)");
});
