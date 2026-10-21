import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig, loadConfig } from "./config";
import { effectiveModel, saveProjectModel, projectModelResolver } from "./project-model";
import { createAgent } from "./agent";
import { open } from "./transcript";
import { fakeProvider, text, toolUse } from "./test/fake-provider";

const home = mkdtempSync(join(tmpdir(), "project-model-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

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
  await Bun.write(join(paths.project("one"), "model"), "\n");
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
      expect(transcript.branch()).toHaveLength(4);
    });
  }
}

test("new provider credential failure is explicit, never a fallback", async () => {
  mkdirSync(paths.project("fail"), { recursive: true });
  await saveProjectModel("fail", "gpt-6-astra");
  const resolve = projectModelResolver("fail", async () => { throw new Error("missing credentials"); });
  await expect(resolve()).rejects.toThrow("Cannot load provider for project fail model gpt-6-astra: missing credentials");
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
