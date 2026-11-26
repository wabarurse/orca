import { expect, test } from "bun:test";
import { parseLogin } from "./login";
import type { ProviderName } from "./accounts";

const accepted: [string[], { provider: ProviderName; profile: string; imported: boolean }][] = [
  [["anthropic"], { provider: "anthropic", profile: "default", imported: false }],
  [["codex", "work", "--import"], { provider: "openai", profile: "work", imported: true }],
  [["claude", "--from-claude-code"], { provider: "anthropic", profile: "default", imported: true }],
];
const refused: string[][] = [[], ["gemini"], ["openai", "a", "b"], ["openai", "--force"], ["openai", "--import", "--import"]];

test.each(accepted)("parseLogin takes a provider (or its alias), an optional profile and one import flag: %p", (args, data) => {
  expect(parseLogin(args)).toEqual({ ok: true, data });
});

test.each(refused.map(args => [args]))("parseLogin refuses %p", args => {
  expect(parseLogin(args).ok).toBe(false);
});
