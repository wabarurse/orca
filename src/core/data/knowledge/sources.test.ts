import { expect, test } from "bun:test";
import { humanText, resolveHumanSource, sourceChoices, type HumanMessage } from "./sources";

const messages: HumanMessage[] = [
  { id: "a", text: "Use bun for everything, never npm", at: "2026-10-28T10:00:00.000Z" },
  { id: "b", text: "yes", at: "2026-10-28T10:01:00.000Z" },
  { id: "c", text: "Use bun for everything, never npm or node", at: "2026-10-28T10:02:00.000Z" },
];

test("exact and contained ids, then quotes; the newest matching message wins", () => {
  expect(resolveHumanSource("a", messages)).toEqual({ id: "a", quote: "Use bun for everything, never npm" });
  expect(resolveHumanSource('"use bun for everything"', messages)).toEqual({ id: "c", quote: "use bun for everything" });
  expect(resolveHumanSource('"yes"', messages)?.id).toBe("b"); // a whole short message
  expect(resolveHumanSource('"bun for"', messages)).toBeNull(); // a short part identifies nothing
  expect(resolveHumanSource("User, 2026-10-28: Use bun for everything, never npm", messages)?.id).toBe("c");
  expect(resolveHumanSource('"use bun" and "never yarn"', messages)).toBeNull(); // every passage must match
});

test("a Questions answer keeps only its human part", () => {
  expect(humanText('[q-1] answer to "Ship it?": "yes": go')).toBe("go");
  expect(humanText("plain")).toBe("plain");
});

test("choices list the newest first with bounded previews", () => {
  expect(sourceChoices(messages, 2)).toBe('- c (2026-10-28T10:02:00.000Z): "Use bun for everything, never npm or node"\n- b (2026-10-28T10:01:00.000Z): "yes"');
  expect(sourceChoices([])).toContain("no human messages");
});
