import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "./config";
import { createOrchestrator } from "./orchestrator";
import { runAgent } from "./agent";
import { saveProjectSettings } from "./project-settings";
import { saveProjectModel } from "./project-model";
import { open } from "./transcript";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import type { ProviderName, CompleteRequest } from "./providers";

const home = mkdtempSync(join(tmpdir(), "model-startup-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("orchestrator 429 → switch → explicit resume: drained task retained, no automatic replay", async () => {
  const project = "resume";
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectModel(project, "claude-start");
  const old = fakeProvider([]);
  old.complete = async () => { throw new Error("429 rate limit"); };
  const next = fakeProvider([[text("resumed")]]);
  const loads: ProviderName[] = [];
  const orch = await createOrchestrator({ project, tools: {}, write() {}, loadProvider: async (name) => {
    loads.push(name); return name === "anthropic" ? old : next;
  } });
  await orch.say("original task");
  await expect(orch.turn()).rejects.toThrow("429 rate limit");
  expect(await orch.pending()).toBe(false);
  expect(JSON.stringify(orch.entries!())).toContain("original task");
  await saveProjectModel(project, "gpt-6-astra");
  expect(await orch.turn()).toEqual([]);
  expect(next.calls).toHaveLength(0);
  expect(loads).toEqual(["anthropic"]);
  await orch.say("resume the previous task");
  await orch.turn();
  expect(loads).toEqual(["anthropic", "openai"]);
  expect(JSON.stringify(next.calls[0]!.messages)).toContain("original task");
  expect(JSON.stringify(next.calls[0]!.messages)).toContain("resume the previous task");
  expect(next.calls[0]!.messages.filter((m) => typeof m.content === "string" && m.content.includes("original task"))).toHaveLength(1);
});

for (const override of [undefined, "claude-opus-5-5"]) {
  test(`production orchestrator startup uses ${override ?? "global fallback"}`, async () => {
    const project = `orch-${override ?? "fallback"}`;
    mkdirSync(paths.project(project), { recursive: true });
    await saveConfig({ model: "gpt-6-astra" });
    if (override) await saveProjectModel(project, override);
    const requests: CompleteRequest[] = [];
    const fake = fakeProvider([[text("done")]]);
    const complete = fake.complete;
    fake.complete = async (req) => { requests.push(req); return complete(req); };
    const loads: ProviderName[] = [];
    const orch = await createOrchestrator({ project, tools: {}, write() {}, loadProvider: async (name) => { loads.push(name); return fake; } });
    await orch.say("hello"); await orch.turn();
    expect(loads).toEqual([override ? "anthropic" : "openai"]);
    expect(requests[0]!.model).toBe(override ?? "gpt-6-astra");
    expect(orch.entries!()[0]).toMatchObject({ type: "meta", model: override ?? "gpt-6-astra" });
  });
}

for (const role of ["worker", "reviewer"] as const) {
  for (const override of [undefined, "claude-opus-5-5"]) {
    test(`production runAgent ${role} startup uses ${override ?? "fallback"} and doesn't auto-restart`, async () => {
      const project = `${role}-${override ?? "fallback"}`;
      const branch = "test";
      mkdirSync(paths.project(project), { recursive: true });
      await saveConfig({ model: "gpt-6-astra" });
      if (override) await saveProjectModel(project, override);
      await saveProjectSettings(project, override ?? "gpt-6-astra", { effort: "high", fast: true });
      const transcript = open(paths.transcript(project, `${role}-${branch}`));
      await transcript.append({ type: "message", message: { role: "user", content: "seeded task" } });
      const fake = fakeProvider([[toolUse("report", "message", { to: "orchestrator", text: "done" })], [text("finished")]]);
      const requests: CompleteRequest[] = [];
      const complete = fake.complete;
      fake.complete = async (req) => { requests.push(req); return complete(req); };
      const loads: ProviderName[] = [];
      expect(await runAgent({ project, role, branch, loadProvider: async (name) => { loads.push(name); return fake; } })).toBe(0);
      expect(loads).toEqual([override ? "anthropic" : "openai", override ? "anthropic" : "openai"]);
      expect(requests[0]!.model).toBe(override ?? "gpt-6-astra");
      expect(requests[0]!.messages[0]!.content).toBe("seeded task");
      expect(requests[0]!.settings).toEqual({ effort: "high", fast: true });
      expect(requests[0]!.tools.some((tool) => tool.name === "message")).toBe(true);
      await saveProjectModel(project, "gpt-after-exit");
      await Bun.sleep(5);
      expect(requests).toHaveLength(2);
    });
  }
}
