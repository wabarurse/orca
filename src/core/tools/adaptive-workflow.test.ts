import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "../../config";
import { makeSpawn } from "./spawn";
import { allTasks } from "../data/tasks";
import { open } from "../data/transcripts";
import { consume, observe } from "../data/inbox";
import { clearWorkingContext, repositoryInstructions, discoverSkills, updateContext, workingContext, remember, facts } from "../data/knowledge";
import { createOrchestrator } from "../agent-loop/orc";
import { createAgent } from "../agent-loop/loop";
import { fakeProvider, text, toolUse } from "../../test/fake-provider";
import { sendAgentFeedback } from "../../tui/commands/feedback";
import { beginRun } from "../tmux/exits";
import type { Runner, StartOptions } from "../tmux/runner";
import { editableTool } from "../definitions";
import { bash } from "./bash/bash";
import { message } from "./message";
import type { ToolContext } from "./registry";

let home: string, prior: string | undefined, cwd: string, ctx: ToolContext;
beforeEach(async () => {
  prior = process.env.ORCA_HOME; home = await mkdtemp(join(tmpdir(), "orca-workflow-")); process.env.ORCA_HOME = home;
  cwd = join(home, "repo"); await mkdir(cwd); await mkdir(paths.project("p"), { recursive: true });
  await saveConfig({ compact: false }); ctx = { project: "p", role: "orchestrator", cwd };
});
afterEach(async () => { if (prior === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = prior; await rm(home, { recursive: true, force: true }); });
function runner(live: string[] = []) {
  const starts: StartOptions[] = [];
  const value: Runner = { start: async opts => { starts.push(opts); }, stop: async () => {}, running: async () => live };
  return { value, starts };
}

test("ordinary delegation and repeated feedback keep one branch without tasks, reviews or publication", async () => {
  const r = runner(), spawn = makeSpawn(r.value);
  const id = await spawn.run({ prompt: "Run the one-off import and report its output", branch: "work-import" }, ctx);
  expect(id).toBe("worker-work-import"); expect(await allTasks("p")).toEqual([]);
  await spawn.run({ prompt: "Use the updated input file; preserve the output folder", branch: "work-import" }, ctx);
  const t = open(paths.transcript("p", id)); expect(await t.chain()).toHaveLength(2);
  await spawn.run({ prompt: "Fresh handoff: retain the output folder, fix only the parser", branch: "work-import", fresh: true }, ctx);
  expect(await t.chain()).toHaveLength(2); // Independent reader remains unchanged until refresh.
  await t.refresh?.(); expect(await t.chain()).toHaveLength(1);
  expect(t.all?.().filter(e => e.type === "message")).toHaveLength(3);
  expect(r.starts.map(s => s.branch)).toEqual(["work-import", "work-import", "work-import"]);
  expect(await allTasks("p")).toEqual([]);
});

// Scripted providers exercise isolation/delivery, not the model's delegation judgment.
test("delegated detail stays with its worker and corrections return to the same owner", async () => {
  const r = runner(), spawn = makeSpawn(r.value);
  const brief = "Determine why the importer fails; fix and validate within scope; report concise evidence.";
  const correction = "Preserve the output folder; handle blank input too.";
  const coordinator = fakeProvider([
    [toolUse("delegate", "spawn", { prompt: brief, branch: "import" })], [text("Started")],
    [text("The importer is fixed; one external check remains unavailable.")],
    [toolUse("feedback", "spawn", { prompt: correction, branch: "import" })], [text("Updating")],
  ]);
  const orch = await createOrchestrator({ project: "p", provider: coordinator, tools: { spawn, message }, write() {} });
  try {
    await orch.say("Fix the importer. Coordinator-only conversation detail.");
    await orch.turn();
    const transcript = open(paths.transcript("p", "worker-import"));
    expect(JSON.stringify(await transcript.chain())).not.toContain("Coordinator-only conversation detail");
    const detail = "Intermediate worker evidence 🐋\n".repeat(300);
    const summary = "abc123: importer fixed; fixture check passed. External service check unavailable; user decision needed before deployment. Evidence follows.";
    const worker = fakeProvider([
      [toolUse("inspect", "inspect", {})],
      [toolUse("report", "message", { to: "orchestrator", text: detail, summary })], [text("Reported")],
    ]);
    const agent = createAgent({ model: "test", provider: worker, transcript, ctx: { ...ctx, role: "worker", branch: "import" }, compaction: { enabled: false }, tools: {
      inspect: { spec: { name: "inspect", input_schema: { type: "object" } }, run: async () => detail }, message,
    }, write() {} });
    await agent.run();
    expect(JSON.stringify(worker.calls[1]!.messages)).toContain("Intermediate worker evidence");
    await orch.turn();
    const retained = JSON.stringify(coordinator.calls[2]!.messages);
    expect(retained).toContain(summary);
    expect(retained).toContain("Full evidence:");
    expect(retained).not.toContain("Intermediate worker evidence");

    await orch.say(correction);
    await orch.turn();
    await transcript.refresh?.();
    expect(JSON.stringify(await transcript.chain())).toContain(correction);
    expect(JSON.stringify(await transcript.chain())).toContain("Intermediate worker evidence");
    expect(r.starts.map(s => [s.role, s.branch])).toEqual([["worker", "import"], ["worker", "import"]]);
    expect(await allTasks("p")).toEqual([]);
  } finally { orch.dispose?.(); }
});

test("a bounded direct command completes without worker, task, review or CI stages", async () => {
  await mkdir(paths.repo("p"), { recursive: true });
  const r = runner();
  const provider = fakeProvider([[toolUse("one-off", "bash", { command: "printf bounded-result" })], [text("Done")]]);
  const orch = await createOrchestrator({ project: "p", provider, tools: { bash, spawn: makeSpawn(r.value) }, write() {} });
  try {
    await orch.say("Run this one command");
    await orch.turn();
    const results = provider.calls[1]!.messages.flatMap(m => typeof m.content === "string" ? [] : m.content)
      .filter(b => b.type === "tool_result" && b.tool_use_id === "one-off");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ content: "bounded-result" });
    expect(r.starts).toEqual([]);
    expect(await allTasks("p")).toEqual([]);
  } finally { orch.dispose?.(); }
});

test("human feedback resumes an idle untracked worker and informs the coordinator without impersonating a user", async () => {
  const r = runner(), spawn = makeSpawn(r.value);
  const id = await spawn.run({ prompt: "Build the preview", branch: "preview" }, ctx);
  await beginRun({ project: "p", id, run: r.starts[0]!.run!, role: "worker", branch: "preview", cwd });
  expect(await sendAgentFeedback("p", id, "Make the title smaller", [], { runner: r.value, spawn })).toBe(`resumed ${id}`);
  expect(r.starts).toHaveLength(2); expect(await allTasks("p")).toEqual([]);
  const latest = (await workingContext("p")).latest!;
  expect(latest.at(-1)?.text).toContain("Make the title smaller");
  await consume("p", "orchestrator", open(paths.transcript("p", "orchestrator")), async messages => {
    expect(messages[0]?.from).toBe("runtime"); expect(messages[0]?.text).toContain(id);
  });
});

test("repository instructions apply by scope and skills remain lazy", async () => {
  await mkdir(join(cwd, ".git")); await mkdir(join(cwd, "src")); await mkdir(join(cwd, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Root rules"); await writeFile(join(cwd, "CLAUDE.md"), "Compatibility rules");
  await writeFile(join(cwd, "src/AGENTS.md"), "Nested rules");
  await writeFile(join(cwd, ".agents/skills/demo/SKILL.md"), "---\ndescription: Inspect the demo\n---\nLarge skill instructions");
  expect(await repositoryInstructions(cwd)).toContain("Root rules");
  expect(await repositoryInstructions(cwd)).not.toContain("Compatibility rules");
  expect(await repositoryInstructions(cwd, join(cwd, "src"))).toContain("Nested rules");
  expect(await repositoryInstructions(cwd)).not.toContain("Nested rules");
  expect(JSON.stringify(await discoverSkills(cwd))).toContain("Inspect the demo");
  expect(JSON.stringify(await discoverSkills(cwd))).not.toContain("Large skill instructions");
});

test("clear resets the working goal and corrections while preserving explicit personal knowledge", async () => {
  const orch = await createOrchestrator({ project: "p", provider: fakeProvider([]), tools: {}, write() {} });
  await updateContext("p", { goal: "Old goal", latest: [{ id: "u1", at: "then", text: "Old correction" }], results: [{ label: "old", location: "old", status: "reported" }] });
  await remember("p", "user", { key: "always.style", text: "Concise", source: "u1", confidence: "explicit", project: "p", updatedAt: "then" });
  await orch.clear!(); expect((await workingContext("p")).latest).toEqual([]); expect((await workingContext("p")).goal).toBeUndefined();
  expect(await facts("p", "user")).toHaveLength(1); orch.dispose?.();
});

test.each(["limit", "refusal", "error"] as const)("%s never executes partial tool calls or claims a finished turn", async stop => {
  const transcript = open(paths.transcript("p", "worker-check"));
  await transcript.append({ type: "message", message: { role: "user", content: "Perform one check" } });
  const provider = fakeProvider([[toolUse("bad", "danger", {})], [text("resumed")]]), original = provider.complete;
  let first = true, executed = 0;
  provider.complete = async req => { const result = await original(req); if (first) { first = false; return { ...result, stop }; } return result; };
  const agent = createAgent({ model: "test", provider, transcript, ctx: { ...ctx, role: "worker", branch: "check" }, compaction: { enabled: false }, tools: { danger: { spec: { name: "danger", input_schema: { type: "object", properties: {} } }, run: async () => { executed++; return "bad"; } } }, write() {} });
  await expect(agent.run()).rejects.toThrow("completion is not established"); expect(executed).toBe(0);
  await agent.run(); expect(executed).toBe(0); expect(await transcript.chain()).toHaveLength(4);
});

test("changed CI observations deduplicate and expose data without inventing human authorization", async () => {
  await observe("p", "ci:1", { head: "one", status: "pending" }, "CI pending");
  await observe("p", "ci:1", { head: "one", status: "pending" }, "CI pending");
  await observe("p", "ci:1", { head: "one", status: "passed" }, "CI passed");
  const t = open(paths.transcript("p", "orchestrator"));
  await consume("p", "orchestrator", t, async messages => { expect(messages).toHaveLength(2); expect(messages.every(m => m.from === "runtime")).toBe(true); });
});

test("edited legacy schemas gain new capabilities while retaining annotations and immutable structure", async () => {
  const spawn = makeSpawn(runner().value); editableTool(spawn); editableTool(bash);
  const file = join(home, "tools/spawn.json"), definition = await Bun.file(file).json();
  delete definition.input_schema.properties.fresh; definition.input_schema.required = ["prompt", "branch", "taskId"];
  definition.description = "My personal delegation guidance"; await writeFile(file, JSON.stringify(definition), { mode: 0o600 });
  const loaded = editableTool(spawn); expect(loaded.spec.description).toContain("My personal delegation guidance");
  expect(loaded.spec.input_schema.required).toEqual(["prompt"]); expect(loaded.spec.input_schema.properties).toHaveProperty("fresh");
  definition.input_schema.properties.prompt.type = "number"; await writeFile(file, JSON.stringify(definition), { mode: 0o600 });
  expect(() => editableTool(spawn)).toThrow("immutable");
});


test("failed context boundary restores the brief without exposing stale context during publication", async () => {
  await updateContext("p", { goal: "Preserve me" });
  await expect(clearWorkingContext("p", async () => {
    expect((await workingContext("p")).goal).toBeUndefined();
    throw new Error("publication failed");
  })).rejects.toThrow("publication failed");
  expect((await workingContext("p")).goal).toBe("Preserve me");
});


test("provider pauses have a finite continuation budget and never execute paused tool calls", async () => {
  for (const withTool of [false, true]) {
    const transcript = open(paths.transcript("p", `pause-${withTool}`));
    await transcript.append({ type: "message", message: { role: "user", content: "Finish this request" } });
    let calls = 0, executed = 0;
    const provider = fakeProvider([]);
    provider.complete = async () => { calls++; return { content: withTool ? [toolUse("partial", "danger", {})] : [text("Waiting")], stop: "pause", completion: "pause_turn" }; };
    const agent = createAgent({ model: "test", provider, transcript, ctx: { ...ctx, role: "worker", branch: "pause" }, compaction: { enabled: false }, tools: { danger: { spec: { name: "danger", input_schema: { type: "object", properties: {} } }, run: async () => { executed++; return "bad"; } } }, write() {} });
    await expect(agent.run()).rejects.toThrow("completion is not established");
    expect(calls).toBe(withTool ? 1 : 3); expect(executed).toBe(0);
  }
});
