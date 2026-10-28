import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readProjectState, saveConfig } from "../../../config";
import { accounts } from "../../../login";
import { fakeProvider } from "../../../test/fake-provider";
import { accountChoices, login, useAccount } from "../../../tui/commands";
import { accountForModel, effectiveAccount, saveProjectAccount, seedProjectAccount } from "./project-account";
import { projectModelResolver, saveProjectModel } from "./project-model";

const home = mkdtempSync(join(tmpdir(), "project-account-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const project = (name: string) => mkdirSync(paths.project(name), { recursive: true });
const dim = (s: string) => s;

test("a project without a choice resolves from its model's provider and the old global profile, without rewriting anything", async () => {
  await saveConfig({ model: "claude-test", account: "old", openaiAccount: "codex-old" });
  project("legacy-a"); project("legacy-b");
  await saveProjectModel("legacy-b", "gpt-6-astra");
  expect(await effectiveAccount("legacy-a")).toEqual({ provider: "anthropic", profile: "old" });
  expect(await effectiveAccount("legacy-b")).toEqual({ provider: "openai", profile: "codex-old" });
  expect(readProjectState("legacy-a", "account")).toBeUndefined();
  expect(readProjectState("legacy-b", "account")).toBeUndefined();
  await saveConfig({ account: "", openaiAccount: "" });
});

test("selection is per project: switching one project leaves the others and the global config alone", async () => {
  project("sel-a"); project("sel-b");
  await saveProjectModel("sel-a", "claude-test"); await saveProjectModel("sel-b", "claude-test");
  await saveProjectAccount("sel-a", { provider: "anthropic", profile: "work" }, undefined);
  expect(await effectiveAccount("sel-a")).toEqual({ provider: "anthropic", profile: "work" });
  expect(await effectiveAccount("sel-b")).toEqual({ provider: "anthropic", profile: "default" });
  expect(readProjectState("sel-b", "account")).toBeUndefined();
  const listed = await accounts(await effectiveAccount("sel-a"));
  expect(listed.filter((a) => a.active).map((a) => a.id)).toEqual(["anthropic:work"]); // one, across both providers
});

test("exactly one account is selected, whichever provider the model uses; a stale saved provider cannot make a second", async () => {
  project("one");
  await saveProjectModel("one", "gpt-6-astra");
  await saveProjectAccount("one", { provider: "openai", profile: "w" }, undefined);
  expect(await accountChoices(dim, "one").then((c) => c.filter((x) => x.current).map((x) => x.value.id))).toEqual(["openai:w"]);
  // The saved choice names a provider that no longer serves the model: the model's provider wins deterministically.
  await saveProjectModel("one", "claude-test");
  expect(await effectiveAccount("one")).toEqual({ provider: "anthropic", profile: "default" });
  expect(await accountChoices(dim, "one").then((c) => c.filter((x) => x.current).map((x) => x.value.id))).toEqual(["anthropic:default"]);
  expect(await accountForModel("gpt-6-astra", { provider: "openai", profile: "w" })).toEqual({ provider: "openai", profile: "w" });
  await expect(accountForModel("gpt-6-astra", { provider: "x", profile: "w" })).rejects.toThrow("invalid project account");
});

test("a switch to the other provider changes the model in the same commit and refuses when the model moved or does not fit", async () => {
  project("cross");
  await saveProjectModel("cross", "claude-test");
  const openai = { provider: "openai" as const, profile: "w" };
  await expect(saveProjectAccount("cross", openai, undefined)).rejects.toThrow("model changed");
  await expect(saveProjectAccount("cross", openai, { from: "claude-test", to: "claude-other" })).rejects.toThrow("not served");
  await expect(saveProjectAccount("cross", openai, { from: "gpt-6-astra", to: "gpt-6-astra" })).rejects.toThrow("model changed");
  await saveProjectAccount("cross", openai, { from: "claude-test", to: "gpt-6-astra" });
  expect(readProjectState("cross", "model")).toBe("gpt-6-astra");
  expect(await effectiveAccount("cross")).toEqual(openai);
});

test("useAccount: same provider keeps the model; another provider moves to its newest model; no models changes nothing", async () => {
  project("use");
  await saveProjectModel("use", "claude-test");
  const catalog = (ids: string[]) => async () => ({ ...fakeProvider([]), models: async () => ids });
  expect(await useAccount({ provider: "anthropic", profile: "p" }, "use")).toContain("using anthropic:p for this project");
  expect(readProjectState("use", "model")).toBe("claude-test");
  await expect(useAccount({ provider: "openai", profile: "w" }, "use", undefined, catalog([]))).rejects.toThrow("offers no models");
  expect(await effectiveAccount("use")).toEqual({ provider: "anthropic", profile: "p" });
  const said = await useAccount({ provider: "openai", profile: "w" }, "use", undefined, catalog(["gpt-6-astra", "gpt-5"]));
  expect(said).toContain("model changed from claude-test to gpt-6-astra");
  expect(await effectiveAccount("use")).toEqual({ provider: "openai", profile: "w" });
});

test("every provider call of a project loads that project's account, not a global one", async () => {
  await saveConfig({ account: "global-profile" });
  project("call-a"); project("call-b");
  await saveProjectModel("call-a", "claude-test"); await saveProjectModel("call-b", "claude-test");
  await saveProjectAccount("call-a", { provider: "anthropic", profile: "mine" }, undefined);
  const seen: (string | undefined)[] = [];
  const load = (async (_name: string, options?: { profile?: string }) => { seen.push(options?.profile); return fakeProvider([]); }) as never;
  await projectModelResolver("call-a", load)();
  await projectModelResolver("call-b", load)();
  expect(seen).toEqual(["mine", "global-profile"]);
  await saveConfig({ account: "" });
});

test("seeding after sign-in selects only for a project with no choice whose model the provider serves", async () => {
  project("seed-none"); project("seed-chosen"); project("seed-other");
  for (const name of ["seed-none", "seed-chosen"]) await saveProjectModel(name, "claude-test");
  await saveProjectModel("seed-other", "gpt-6-astra");
  await saveProjectAccount("seed-chosen", { provider: "anthropic", profile: "keep" }, undefined);
  const fresh = { provider: "anthropic" as const, profile: "fresh" };
  expect(await seedProjectAccount("seed-none", fresh)).toBe(true);
  expect(await seedProjectAccount("seed-chosen", fresh)).toBe(false);
  expect(await seedProjectAccount("seed-other", fresh)).toBe(false);
  expect(await effectiveAccount("seed-none")).toEqual(fresh);
  expect(await effectiveAccount("seed-chosen")).toEqual({ provider: "anthropic", profile: "keep" });
  expect(readProjectState("seed-other", "model")).toBe("gpt-6-astra");
});

test("/login stores global credentials only: no config write, no change to a chosen project", async () => {
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  await Bun.write(join(home, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }));
  project("login-chosen"); project("login-none");
  for (const name of ["login-chosen", "login-none"]) await saveProjectModel(name, "claude-test");
  await saveProjectAccount("login-chosen", { provider: "anthropic", profile: "keep" }, undefined);
  const io = { write: () => {}, signal: new AbortController().signal };
  expect(await login("anthropic added --from-claude-code", io, { name: "login-chosen" })).toContain("choose it for a project with /accounts");
  expect(await effectiveAccount("login-chosen")).toEqual({ provider: "anthropic", profile: "keep" });
  expect(await login("anthropic added --from-claude-code", io, { name: "login-none" })).toContain("this project now uses it");
  expect(await effectiveAccount("login-none")).toEqual({ provider: "anthropic", profile: "added" });
  expect(await login("anthropic more --from-claude-code", io, { name: "login-chosen", select: true })).toContain("using anthropic:more for this project");
  expect(await login("anthropic gone --from-claude-code", io, { name: "missing-project" })).toContain("signed in to anthropic:gone (claude code / claude subscription); not selected for this project");
  expect(await effectiveAccount("login-chosen")).toEqual({ provider: "anthropic", profile: "more" });
  expect((await accounts()).some((a) => a.active)).toBe(false);
});
