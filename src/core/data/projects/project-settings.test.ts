import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "../../../config/config";
import { effectiveSettings, effectiveSettingsReport, effortCommand, fastCommand, saveProjectSettings, validateSettings } from "./project-settings";
import { clearCatalogEfforts, rememberCatalogEfforts } from "../../../providers/catalog/capabilities";
import { clearCatalogLimits } from "../../../providers/catalog/context-window";
import { codexRequestSettings } from "../../../providers/openai";
import { effortChoices } from "../../../tui/commands/commands";
import { saveProjectModel, projectModelResolver } from "./project-model";
import { createAgent } from "../../agent-loop/loop/agent";
import { open } from "../transcripts/transcript";
import { fakeProvider, toolUse, text } from "../../../test/fake-provider";
import type { CompleteRequest } from "../../../providers";
const home = mkdtempSync(join(tmpdir(), "project-settings-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(clearCatalogLimits);

async function setup(project: string, model = "gpt-6-astra") {
  mkdirSync(paths.project(project), { recursive: true });
  await saveConfig({ model: "gpt-6-astra" });
  await saveProjectModel(project, model);
}

test("query/set/default/off preserve backend defaults and isolate project/model preferences", async () => {
  await setup("settings");
  expect(await effortCommand("settings", "")).toContain("default (backend default)");
  expect(await effortCommand("settings", "")).toContain("default, low, medium, high, xhigh, max");
  expect(await fastCommand("settings", "")).toContain("off");
  expect(await effectiveSettings("settings", "gpt-6-astra")).toEqual({});
  expect(await effortCommand("settings", "max")).toContain("next model request");
  expect(await fastCommand("settings", "on")).toContain("premium");
  expect(await effectiveSettings("settings", "gpt-6-astra")).toEqual({ effort: "max", fast: true });
  expect(await effectiveSettings("other", "gpt-6-astra")).toEqual({});
  await effortCommand("settings", "default"); await fastCommand("settings", "off");
  expect(await effectiveSettings("settings", "gpt-6-astra")).toEqual({ fast: false });
});

test("unsupported effort/fast/model refusals leave saved state unchanged", async () => {
  await setup("refuse", "claude-sonnet-4-6");
  await effortCommand("refuse", "high");
  const path = join(paths.project("refuse"), "model-settings.json");
  const before = await Bun.file(path).text();
  for (const effort of ["xhigh", "ultra", "banana"]) await expect(effortCommand("refuse", effort)).rejects.toThrow("unsupported");
  await expect(fastCommand("refuse", "on")).rejects.toThrow("unsupported");
  await expect(fastCommand("refuse", "yes")).rejects.toThrow("usage");
  expect(await Bun.file(path).text()).toBe(before);
  await saveProjectModel("refuse", "unknown-model");
  await expect(effortCommand("refuse", "high")).rejects.toThrow("unsupported");
  await expect(fastCommand("refuse", "on")).rejects.toThrow("unsupported");
  expect(await Bun.file(path).text()).toBe(before);
});

test("switching incompatible models omits options and switching back restores explicit preference", async () => {
  await setup("switch");
  await effortCommand("switch", "xhigh"); await fastCommand("switch", "on");
  const provider = fakeProvider([]);
  const resolve = projectModelResolver("switch", async () => provider);
  expect((await resolve()).settings).toEqual({ effort: "xhigh", fast: true });
  await saveProjectModel("switch", "claude-sonnet-4-6");
  expect((await resolve()).settings).toEqual({});
  await effortCommand("switch", "medium");
  await saveProjectModel("switch", "gpt-6-astra");
  expect((await resolve()).settings).toEqual({ effort: "xhigh", fast: true });
});

test("a catalog that drops a saved effort mid-run omits it from requests instead of failing the turn", async () => {
  await setup("catalog-shrink");
  await effortCommand("catalog-shrink", "xhigh"); await fastCommand("catalog-shrink", "on");
  const provider = fakeProvider([]);
  const resolve = projectModelResolver("catalog-shrink", async () => provider);
  expect((await resolve()).settings).toEqual({ effort: "xhigh", fast: true }); // first request: built-in table
  try {
    rememberCatalogEfforts([["gpt-6-astra", ["low", "medium", "high"]]]); // the background prefetch lands with fewer levels
    expect((await resolve()).settings).toEqual({ fast: true });
    expect(await effectiveSettingsReport("catalog-shrink", "gpt-6-astra")).toEqual({ settings: { fast: true }, dropped: "xhigh" });
    expect(await effortCommand("catalog-shrink", "")).toContain("default (backend default)");
    // The provider-side check accepts any level the table or the catalog ever reported, so a request resolved just before the catalog landed still goes out.
    expect(codexRequestSettings("gpt-6-astra", { effort: "xhigh" }).reasoning.effort).toBe("xhigh");
    expect(() => validateSettings("gpt-6-astra", { effort: "max" })).not.toThrow();
    // Saves follow the current list; the picker marks default and explains.
    await expect(effortCommand("catalog-shrink", "xhigh")).rejects.toThrow("supported: default, low, medium, high");
    const picker = await effortChoices("catalog-shrink", async () => provider);
    expect(picker.choices).toEqual([{ value: "default", label: "default", current: true }, { value: "low", label: "low", current: false }, { value: "medium", label: "medium", current: false }, { value: "high", label: "high", current: false }]);
    expect(picker.note).toContain("saved effort xhigh is not supported");
    // Patching another field does not carry the dead effort along; the file keeps it until then.
    expect(JSON.parse(await Bun.file(join(paths.project("catalog-shrink"), "model-settings.json")).text())["gpt-6-astra"]).toEqual({ effort: "xhigh", fast: true });
    await fastCommand("catalog-shrink", "off");
    expect(JSON.parse(await Bun.file(join(paths.project("catalog-shrink"), "model-settings.json")).text())["gpt-6-astra"]).toEqual({ fast: false });
  } finally { clearCatalogEfforts(); }
  await effortCommand("catalog-shrink", "xhigh");
  clearCatalogEfforts();
  expect((await resolve()).settings).toEqual({ effort: "xhigh", fast: false }); // another process without the catalog: the table applies again
  await expect(effectiveSettings("catalog-shrink", "gpt-5.5")).resolves.toEqual({}); // unrelated models unaffected
});

test("effortChoices waits for the provider catalog, lists its levels and falls back without an account", async () => {
  await setup("choices", "gpt-5.5");
  await effortCommand("choices", "high");
  let fetches = 0;
  const catalog = { ...fakeProvider([]), name: "openai" as const, async models() { fetches++; rememberCatalogEfforts([["gpt-5.5", ["medium", "high", "max"]]]); return ["gpt-5.5"]; } };
  try {
    const first = await effortChoices("choices", async () => catalog);
    expect(first).toEqual({ model: "gpt-5.5", current: "high", choices: [{ value: "default", label: "default", current: false }, { value: "medium", label: "medium", current: false }, { value: "high", label: "high", current: true }, { value: "max", label: "max", current: false }] });
    await effortChoices("choices", async () => catalog);
    expect(fetches).toBe(1); // once per process, shared with the context-limit prefetch
  } finally { clearCatalogEfforts(); }
  const none = await effortChoices("choices", async () => { throw new Error("no account"); });
  expect(none.choices.map((c) => c.value)).toEqual(["default", "low", "medium", "high", "xhigh"]);
  expect(none.choices.find((c) => c.current)?.value).toBe("high");
});

for (const role of ["orchestrator", "worker", "reviewer"] as const) {
  test(`${role} picks settings before next request, after running tools finish`, async () => {
    await setup(role);
    const transcript = open(paths.transcript(role, role));
    await transcript.append({ type: "message", message: { role: "user", content: "original task" } });
    const fake = fakeProvider([[toolUse("switch", "settings", {})], [text("done")]]);
    const requests: CompleteRequest[] = [];
    const complete = fake.complete;
    fake.complete = async (req) => { requests.push(req); return complete(req); };
    await createAgent({ model: "unused", resolveModel: projectModelResolver(role, async () => fake), transcript,
      ctx: { project: role, role, cwd: "/same" }, write() {},
      tools: { settings: { spec: { name: "settings", description: "settings", input_schema: { type: "object" } }, async run() {
        await saveProjectSettings(role, "gpt-6-astra", { effort: "high", fast: true });
        expect(requests).toHaveLength(1);
        return "finished tool";
      } } },
    }).run();
    expect(requests[0]!.settings).toEqual({});
    expect(requests[1]!.settings).toEqual({ effort: "high", fast: true });
    expect(JSON.stringify(requests[1]!.messages)).toContain("finished tool");
    expect(requests[1]!.messages[0]!.content).toBe("original task");
  });
}

for (const [label, entry] of Object.entries({
  null: null, array: [], arrayValues: ["bad"], string: "bad", number: 7, boolean: false,
  effortNull: { effort: null }, effortNumber: { effort: 7 }, effortBoolean: { effort: true },
  effortArray: { effort: [] }, effortObject: { effort: {} },
  fastNull: { fast: null }, fastString: { fast: "on" }, fastNumber: { fast: 1 },
  fastArray: { fast: [] }, fastObject: { fast: {} },
  unexpected: { effort: "high", extra: true }, numericKeys: { "0": "b", "1": "a", "2": "d" },
})) {
  test(`malformed selected entry ${label}: all writes/reset attempts refuse without changing bytes`, async () => {
    const project = `malformed-${label}`;
    await setup(project);
    const path = join(paths.project(project), "model-settings.json");
    const before = `  ${JSON.stringify({ "gpt-6-astra": entry, "claude-opus-5-5": { effort: "low" } }, null, 2)}\n\n`;
    await Bun.write(path, before);
    const attempts = [
      () => effortCommand(project, "high"), () => effortCommand(project, "default"),
      () => fastCommand(project, "on"), () => fastCommand(project, "off"),
      () => effectiveSettings(project, "gpt-6-astra"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow("invalid");
      expect(await Bun.file(path).text()).toBe(before);
    }
  });
}

test("default/off can reset well-shaped but no-longer-supported preferences", async () => {
  await setup("valid-reset", "claude-sonnet-4-6");
  const path = join(paths.project("valid-reset"), "model-settings.json");
  await Bun.write(path, JSON.stringify({ "claude-sonnet-4-6": { effort: "xhigh", fast: false } }));
  await effortCommand("valid-reset", "default");
  expect(await effectiveSettings("valid-reset", "claude-sonnet-4-6")).toEqual({ fast: false });
  await Bun.write(path, JSON.stringify({ "claude-sonnet-4-6": { effort: "high", fast: true } }));
  await fastCommand("valid-reset", "off");
  expect(await effectiveSettings("valid-reset", "claude-sonnet-4-6")).toEqual({ effort: "high", fast: false });
});

import { withProjectStateLock } from "./state";
import { effectiveModel } from "./project-model";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("settings save queued behind model switch rejects old target, preserving both model preferences", async () => {
  const project = "queued-switch";
  await setup(project);
  const path = join(paths.project(project), "model-settings.json");
  const before = '{\n "gpt-6-astra": {"effort":"low"}, "claude-opus-5-5": {"fast":false}\n}\n';
  await Bun.write(path, before);
  const entered = deferred();
  const release = deferred();
  const blocker = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  // Order is reserved synchronously at the save APIs, not during command reads.
  const switching = saveProjectModel(project, "claude-opus-5-5");
  const saving = saveProjectSettings(project, "gpt-6-astra", { effort: "high" }).catch((error: Error) => error);
  release.resolve();
  await blocker; await switching;
  expect(String(await saving)).toContain("model changed while saving settings; try again");
  expect(await effectiveModel(project)).toBe("claude-opus-5-5");
  expect(await Bun.file(path).text()).toBe(before);
});

for (const effortFirst of [true, false]) {
  test(`queued effort/fast patches preserve both fields (effort first: ${effortFirst})`, async () => {
    const project = `queued-patches-${effortFirst}`;
    await setup(project);
    const entered = deferred();
    const release = deferred();
    const blocker = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const patches = effortFirst ? [{ effort: "high" as const }, { fast: true }] : [{ fast: true }, { effort: "high" as const }];
    const first = saveProjectSettings(project, "gpt-6-astra", patches[0]!);
    const second = saveProjectSettings(project, "gpt-6-astra", patches[1]!);
    release.resolve();
    await blocker; await second; await first;
    expect(await effectiveSettings(project, "gpt-6-astra")).toEqual({ effort: "high", fast: true });
  });
}

test("unexpected patch keys are explicit refusals and leave saved bytes intact", async () => {
  await setup("patch-refusal");
  await effortCommand("patch-refusal", "high");
  const path = join(paths.project("patch-refusal"), "model-settings.json");
  const before = await Bun.file(path).text();
  const patch = { fast: true, extra: "bad" } as Parameters<typeof saveProjectSettings>[2];
  await expect(saveProjectSettings("patch-refusal", "gpt-6-astra", patch)).rejects.toThrow("unexpected keys: extra");
  expect(await Bun.file(path).text()).toBe(before);
});
