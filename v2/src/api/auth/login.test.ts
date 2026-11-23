import { expect, test } from "bun:test";
import { parseLogin } from "./login";

test("parseLogin takes a provider (or its alias), an optional profile and one import flag", () => {
  expect(parseLogin(["anthropic"])).toEqual({ ok: true, data: { provider: "anthropic", profile: "default", imported: false } });
  expect(parseLogin(["codex", "work", "--import"])).toEqual({ ok: true, data: { provider: "openai", profile: "work", imported: true } });
  expect(parseLogin(["claude", "--from-claude-code"])).toEqual({ ok: true, data: { provider: "anthropic", profile: "default", imported: true } });
  for (const bad of [[], ["gemini"], ["openai", "a", "b"], ["openai", "--force"], ["openai", "--import", "--import"]]) expect(parseLogin(bad).ok).toBe(false);
});
