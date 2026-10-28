import { expect, test } from "bun:test";
import { humanText, resolveHumanSource, sourceChoices, type HumanMessage } from "./sources";

const messages: HumanMessage[] = [
  { id: "a", text: "Use bun for everything, never npm", at: "2026-10-28T10:00:00.000Z" },
  { id: "b", text: "yes", at: "2026-10-28T10:01:00.000Z" },
  { id: "c", text: "Use bun for everything, never npm or node", at: "2026-10-28T10:02:00.000Z" },
];

test("exact and contained ids, then quotes; the newest matching message wins", () => {
  expect(resolveHumanSource("a", messages)).toEqual({ id: "a", quote: "Use bun for everything, never npm" });
  expect(resolveHumanSource('"use bun for everything"', messages)).toEqual({ id: "c", quote: "Use bun for everything" });
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

test("pieces elided with … must each be long enough and appear in order: stitched fragments match nothing", () => {
  const tabs: HumanMessage[] = [{ id: "t", text: "Always use spaces, never tabs in this repo", at: "2026-10-28T11:00:00.000Z" }];
  expect(resolveHumanSource('"always use … tabs"', tabs)).toBeNull(); // "tabs" is too short a piece
  expect(resolveHumanSource('"never tabs … always use spaces"', tabs)).toBeNull(); // out of order
  expect(resolveHumanSource('"never tabs in" and "always use spaces"', [...tabs, ...messages])).toBeNull(); // separate quotes are ordered pieces too
  expect(resolveHumanSource('"always use spaces" and "never tabs in"', tabs)?.id).toBe("t");
  expect(resolveHumanSource('"always use spaces … never tabs"', tabs)?.id).toBe("t");
  expect(resolveHumanSource('"use spaces, … tabs in this"', tabs)).toEqual({ id: "t", quote: "use spaces, never tabs in this" });
  expect(resolveHumanSource('"always use spaces … always use spaces"', tabs)).toBeNull(); // pieces cannot overlap or repeat
  expect(resolveHumanSource('"never … npm … node"', messages)).toBeNull();
});

test("the stored quote is the matched message's own words, never the caller's passage", () => {
  const tabs: HumanMessage[] = [{ id: "t", text: "Always use \u201cspaces\u201d,  never   tabs in this repo", at: "2026-10-28T11:00:00.000Z" }];
  // Lowercase, missing quote marks, collapsed spaces and an ellipsis in the source: the stored quote is the message's span.
  expect(resolveHumanSource('User said: "always use spaces … never tabs"', tabs))
    .toEqual({ id: "t", quote: "Always use \u201cspaces\u201d, never tabs" });
  expect(resolveHumanSource("User, 2026-10-28: ALWAYS USE SPACES, NEVER TABS", tabs)?.quote).toBe("Always use \u201cspaces\u201d, never tabs");
  const answer: HumanMessage[] = [{ id: "q", text: '[q-1] answer to "Which package manager?": Bun everywhere, please', at: "2026-10-28T11:01:00.000Z" }];
  expect(resolveHumanSource('"bun everywhere"', answer)).toEqual({ id: "q", quote: "Bun everywhere" });
});
