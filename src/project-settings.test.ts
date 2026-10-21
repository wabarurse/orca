import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "./config";
import { effectiveSettings, effortCommand, fastCommand, saveProjectSettings } from "./project-settings";
import { saveProjectModel, projectModelResolver } from "./project-model";
import { createAgent } from "./agent";
import { open } from "./transcript";
import { fakeProvider, toolUse, text } from "./test/fake-provider";
import type { CompleteRequest } from "./providers";
const home = mkdtempSync(join(tmpdir(), "project-settings-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

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
