import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig, loadConfig, readProjectState, writeProjectState } from "../../../config";
import { effectiveModel, saveProjectModel, projectModelResolver, roleOverrides, saveRoleModel } from "./project-model";
import { saveProjectSettings } from "./project-settings";
import { createAgent } from "../../agent-loop/loop/agent";
import { open } from "../transcripts/transcript";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import { clearCatalogLimits } from "../../../providers/catalog/context-window";
import type { Provider } from "../../../providers/provider";

const home = mkdtempSync(join(tmpdir(), "project-model-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(clearCatalogLimits);

test("project override is atomic, validated and leaves the global default and other projects alone", async () => {
  await saveConfig({ model: "gpt-6-astra" });
  mkdirSync(paths.project("one"), { recursive: true });
  expect(await effectiveModel("one")).toBe("gpt-6-astra");
  await saveProjectModel("one", "claude-test");
  expect(await effectiveModel("one")).toBe("claude-test");
  expect(await effectiveModel("other")).toBe("gpt-6-astra");
  expect((await loadConfig()).model).toBe("gpt-6-astra");
  await expect(saveProjectModel("one", "bad\nmodel")).rejects.toThrow("invalid model");
  await expect(saveProjectModel("../escape", "gpt-test")).rejects.toThrow("invalid project");
  expect(await effectiveModel("one")).toBe("claude-test");
  writeProjectState("one", "model", "");
  await expect(effectiveModel("one")).rejects.toThrow("invalid model");
});

for (const role of ["orchestrator", "worker", "reviewer"] as const) {
  for (const [before, after] of [["claude-test", "gpt-6-astra"], ["gpt-6-astra", "claude-test"]]) {
    test(`${role}: ${before} → ${after} at next request keeps tools, cwd and transcript`, async () => {
      const project = `${role}-${before}`;
      mkdirSync(paths.project(project), { recursive: true });
      await saveProjectModel(project, before!);
      const transcript = open(paths.transcript(project, role));
      await transcript.append({ type: "message", message: { role: "user", content: "original task" } });
      const first = fakeProvider([[toolUse("call_1", "switch", {})]]);
      const second = fakeProvider([[text("finished")]]);
      const requested: string[] = [];
      for (const fake of [first, second]) {
        const complete = fake.complete;
        fake.complete = async (req) => { requested.push(req.model); return complete(req); };
      }
      const resolveModel = projectModelResolver(project, async (name) => name === (before!.startsWith("claude") ? "anthropic" : "openai") ? first : second);
      let finished = false;
      await createAgent({
        model: before!, resolveModel, transcript, ctx: { project, role, cwd: "/preserved-worktree" }, write: () => {},
        tools: { switch: {
          spec: { name: "switch", description: "switch", input_schema: { type: "object" } },
          async run(_, ctx) {
            await saveProjectModel(project, after!);
            expect(second.calls).toHaveLength(0);
            expect(ctx.cwd).toBe("/preserved-worktree");
            finished = true;
            return "tool finished";
          },
        } },
      }).run();
      expect(finished).toBe(true);
      expect(requested).toEqual([before!, after!]);
      expect(second.calls[0]!.messages[0]!.content).toBe("original task");
      expect(JSON.stringify(second.calls[0]!.messages)).toContain("tool finished");
      expect(second.calls[0]!.tools[0]).toBe("switch");
      expect(transcript.branch().filter(e => e.type !== "model-request")).toHaveLength(4);
    });
  }
}

test("new provider credential failure is explicit, never a fallback", async () => {
  mkdirSync(paths.project("fail"), { recursive: true });
  await saveProjectModel("fail", "gpt-6-astra");
  const resolve = projectModelResolver("fail", async () => { throw new Error("missing credentials"); });
  await expect(resolve()).rejects.toThrow("cannot load provider for project fail model gpt-6-astra: missing credentials");
});

test("resolving prefetches the model catalog once in the background; load failures do not", async () => {
  mkdirSync(paths.project("prefetch"), { recursive: true });
  await saveProjectModel("prefetch", "gpt-6-astra");
  let calls = 0;
  const pending: Provider = { name: "openai", async complete() { throw new Error("unused"); },
    models: () => { calls++; return new Promise<string[]>(() => {}); } };
  let fail = true;
  const resolve = projectModelResolver("prefetch", async () => { if (fail) throw new Error("missing credentials"); return pending; });
  await expect(resolve()).rejects.toThrow("cannot load provider for project prefetch model gpt-6-astra: missing credentials");
  await Bun.sleep(0);
  expect(calls).toBe(0);
  fail = false;
  expect((await resolve()).provider).toBe(pending); // Returns although models() never settles.
  await Bun.sleep(0);
  expect(calls).toBe(1);
  await resolve();
  await Bun.sleep(0);
  expect(calls).toBe(1);
});

test("a switch during an in-flight request takes effect only after its tools finish", async () => {
  const project = "in-flight";
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectModel(project, "claude-test");
  const transcript = open(paths.transcript(project, "worker"));
  await transcript.append({ type: "message", message: { role: "user", content: "task" } });
  const old = fakeProvider([[toolUse("call_1", "echo", {})]]);
  const next = fakeProvider([[text("done")]]);
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const complete = old.complete;
  old.complete = async (req) => { entered(); await gate; expect(req.model).toBe("claude-test"); return complete(req); };
  let toolFinished = false;
  const run = createAgent({ model: "unused", transcript, write() {}, ctx: { project, role: "worker", cwd: "/same" },
    resolveModel: projectModelResolver(project, async (name) => name === "anthropic" ? old : next),
    tools: { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, async run() { toolFinished = true; return "finished"; } } },
  }).run();
  await started;
  await saveProjectModel(project, "gpt-6-astra");
  expect(next.calls).toHaveLength(0);
  expect(toolFinished).toBe(false);
  release();
  await run;
  expect(toolFinished).toBe(true);
  expect(JSON.stringify(next.calls[0]!.messages)).toContain("finished");
});

test("role overrides: each role resolves its own model, others keep the project model; settings are per resolved model", async () => {
  const project = "roles";
  mkdirSync(paths.project(project), { recursive: true });
  // /effort saves for the project model, so sonnet's effort is saved while it is the project model; it stays sonnet's own.
  await saveProjectModel(project, "claude-sonnet-5");
  await saveProjectSettings(project, "claude-sonnet-5", { effort: "low" });
  await saveProjectModel(project, "claude-opus-5");
  await saveRoleModel(project, "worker", "claude-sonnet-5");
  expect(readProjectState(project, "role-models")).toEqual({ anthropic: { worker: "claude-sonnet-5" } });
  expect(await effectiveModel(project)).toBe("claude-opus-5");
  expect(await effectiveModel(project, "worker")).toBe("claude-sonnet-5");
  expect(await effectiveModel(project, "reviewer")).toBe("claude-opus-5");
  expect(await effectiveModel(project, "orchestrator")).toBe("claude-opus-5");
  const fake = fakeProvider([]);
  const worker = await projectModelResolver(project, async () => fake, "worker")();
  expect(worker.model).toBe("claude-sonnet-5");
  expect(worker.settings).toEqual({ effort: "low" });
  expect((await projectModelResolver(project, async () => fake, "reviewer")()).model).toBe("claude-opus-5");
  expect((await projectModelResolver(project, async () => fake)()).model).toBe("claude-opus-5"); // no role: the project model
  // Clearing ("same as project"), and saving the project model itself as an override, both leave the role following the project.
  await saveRoleModel(project, "worker", undefined);
  expect(await effectiveModel(project, "worker")).toBe("claude-opus-5");
  await saveRoleModel(project, "reviewer", "claude-opus-5");
  expect(roleOverrides(project, "claude-opus-5")).toEqual({});
  expect(readProjectState(project, "role-models")).toEqual({});
});

test("a role override must be the project provider's model; another provider's saved overrides are ignored", async () => {
  const project = "roles-provider";
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectModel(project, "claude-opus-5");
  await expect(saveRoleModel(project, "worker", "gpt-6-astra")).rejects.toThrow("not served by this project's anthropic account");
  await expect(saveRoleModel(project, "worker", "bad\nmodel")).rejects.toThrow("invalid model");
  await expect(saveRoleModel(project, "nobody" as never, "claude-x")).rejects.toThrow("invalid role");
  expect(readProjectState(project, "role-models")).toBeUndefined();
  // Hand-written: an OpenAI override and a mismatched entry; neither applies to the Claude project model.
  writeProjectState(project, "role-models", { openai: { worker: "gpt-5" }, anthropic: { reviewer: "gpt-5", orchestrator: "claude-haiku-5-5" } });
  expect(await effectiveModel(project, "worker")).toBe("claude-opus-5");
  expect(await effectiveModel(project, "reviewer")).toBe("claude-opus-5");
  expect(await effectiveModel(project, "orchestrator")).toBe("claude-haiku-5-5");
  writeProjectState(project, "role-models", ["not", "a", "record"]);
  await expect(effectiveModel(project, "worker")).rejects.toThrow("invalid project role models");
  expect(await effectiveModel(project)).toBe("claude-opus-5"); // the project model alone does not read the overrides
});

test("saving the project model (all agents) clears that provider's role overrides in the same commit, not another provider's", async () => {
  const project = "roles-all";
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectModel(project, "claude-opus-5");
  await saveRoleModel(project, "worker", "claude-sonnet-5");
  await saveRoleModel(project, "orchestrator", "claude-haiku-5-5");
  writeProjectState(project, "role-models", { ...readProjectState<object>(project, "role-models"), openai: { reviewer: "gpt-5" } });
  await saveProjectModel(project, "claude-opus-5-5");
  expect(readProjectState(project, "role-models")).toEqual({ openai: { reviewer: "gpt-5" } });
  expect(await effectiveModel(project, "worker")).toBe("claude-opus-5-5");
  expect(await effectiveModel(project, "orchestrator")).toBe("claude-opus-5-5");
});

test("a role override switches at that role's next request only", async () => {
  const project = "roles-next";
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectModel(project, "claude-opus-5");
  const transcript = open(paths.transcript(project, "reviewer"));
  await transcript.append({ type: "message", message: { role: "user", content: "review" } });
  const fake = fakeProvider([[toolUse("call_1", "switch", {})], [text("done")]]);
  const requested: string[] = [];
  const complete = fake.complete;
  fake.complete = async (req) => { requested.push(req.model); return complete(req); };
  await createAgent({
    model: "claude-opus-5", resolveModel: projectModelResolver(project, async () => fake, "reviewer"), transcript, write: () => {},
    ctx: { project, role: "reviewer", cwd: "/same" },
    tools: { switch: { spec: { name: "switch", description: "switch", input_schema: { type: "object" } }, async run() {
      await saveRoleModel(project, "worker", "claude-sonnet-5"); // another role: no effect here
      await saveRoleModel(project, "reviewer", "claude-haiku-5-5");
      return "switched";
    } } },
  }).run();
  expect(requested).toEqual(["claude-opus-5", "claude-haiku-5-5"]);
});
