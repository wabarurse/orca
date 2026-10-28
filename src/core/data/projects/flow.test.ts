import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadConfig, paths, saveConfig } from "../../../config/config";
import { effectiveFlow, flowSettingsPath, saveProjectFlow, validateFlow } from "./flow";
import { projectIdentity, withProjectStateLock } from "./state";
import { rolePrompt, DYNAMIC_DISPATCH } from "../../prompt/shared";
import { createOrchestrator } from "../../agent-loop/orc/orchestrator";
import { fakeProvider, text } from "../../../test/fake-provider";

const home = mkdtempSync(join(tmpdir(), "project-flow-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const setup = (project: string) => mkdirSync(paths.project(project), { recursive: true });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

test("config.toml is the default; a project override is atomic, merged and leaves config and other projects alone", async () => {
  setup("one"); setup("other");
  expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: defaults.maxReviewRounds, dynamicDispatch: defaults.dynamicDispatch });
  await saveConfig({ maxReviewRounds: 4, dynamicDispatch: true });
  expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: 4, dynamicDispatch: true });
  await saveProjectFlow("one", { maxReviewRounds: 0 });
  expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: 0, dynamicDispatch: true }); // the other key still follows config
  await saveProjectFlow("one", { dynamicDispatch: false });
  expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: 0, dynamicDispatch: false }); // the earlier key survives the merge
  expect(await effectiveFlow("other")).toEqual({ maxReviewRounds: 4, dynamicDispatch: true });
  expect(await loadConfig()).toMatchObject({ maxReviewRounds: 4, dynamicDispatch: true });
  expect(JSON.parse(await Bun.file(flowSettingsPath("one")).text())).toEqual({ maxReviewRounds: 0, dynamicDispatch: false });
  expect(readdirSync(paths.project("one")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  // An explicitly loaded config is honoured without re-reading the file.
  expect(await effectiveFlow("other", { maxReviewRounds: 9, dynamicDispatch: false })).toEqual({ maxReviewRounds: 9, dynamicDispatch: false });
  await saveConfig({ maxReviewRounds: 1, dynamicDispatch: false });
});

test("invalid patches and ids refuse before writing; malformed saved files fail closed and are never repaired", async () => {
  setup("bad");
  await saveProjectFlow("bad", { maxReviewRounds: 2 });
  const before = await Bun.file(flowSettingsPath("bad")).text();
  for (const patch of [{ maxReviewRounds: -1 }, { maxReviewRounds: 101 }, { maxReviewRounds: 1.5 }, { maxReviewRounds: "2" }, { dynamicDispatch: "on" }, { dynamicDispatch: 1 }, { extra: true }, null, [], 3]) {
    await expect(saveProjectFlow("bad", patch as Parameters<typeof saveProjectFlow>[1])).rejects.toThrow(/invalid/);
    expect(() => validateFlow(patch)).toThrow(/invalid/);
  }
  await expect(saveProjectFlow("../escape", { maxReviewRounds: 1 })).rejects.toThrow("invalid project id");
  await expect(saveProjectFlow("missing-dir", { maxReviewRounds: 1 })).rejects.toThrow();
  expect(await Bun.file(flowSettingsPath("bad")).text()).toBe(before);
  for (const raw of ["not json", '{"maxReviewRounds": 101}', '{"dynamicDispatch": "on"}', '{"other": 1}', "[]", "null", '{"maxReviewRounds": 9007199254740993}']) {
    await Bun.write(flowSettingsPath("bad"), raw);
    await expect(effectiveFlow("bad")).rejects.toThrow(flowSettingsPath("bad"));
    await expect(saveProjectFlow("bad", { dynamicDispatch: true })).rejects.toThrow(flowSettingsPath("bad")); // a save never silently repairs it
    expect(await Bun.file(flowSettingsPath("bad")).text()).toBe(raw);
  }
  await Bun.write(flowSettingsPath("bad"), "{}\n");
  expect(await effectiveFlow("bad")).toEqual({ maxReviewRounds: defaults.maxReviewRounds, dynamicDispatch: defaults.dynamicDispatch });
});

test("saves queue in invocation order under the project-state lock and keep both fields", async () => {
  const project = "queued";
  setup(project);
  const entered = deferred(), release = deferred();
  const blocker = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const first = saveProjectFlow(project, { maxReviewRounds: 3 });
  const second = saveProjectFlow(project, { dynamicDispatch: true });
  const third = saveProjectFlow(project, { maxReviewRounds: 5 });
  expect(await Bun.file(flowSettingsPath(project)).exists()).toBe(false); // nothing written while the lock is held
  release.resolve();
  await blocker; await first; await second; await third;
  expect(await effectiveFlow(project)).toEqual({ maxReviewRounds: 5, dynamicDispatch: true });
});

test("a save captured for a deleted and recreated project refuses instead of resurrecting it", async () => {
  const project = "recreated";
  setup(project);
  const identity = projectIdentity(project);
  rmSync(paths.project(project), { recursive: true, force: true });
  await Bun.sleep(5);
  setup(project);
  await expect(saveProjectFlow(project, { maxReviewRounds: 2 }, identity)).rejects.toThrow("project changed");
  expect(await Bun.file(flowSettingsPath(project)).exists()).toBe(false);
});

test("the orchestrator's prompt uses its project's review rounds and dispatch per turn, not config.toml's", async () => {
  await saveConfig({ maxReviewRounds: 1, dynamicDispatch: false });
  const project = "prompted";
  setup(project);
  const systems: (string | undefined)[] = [];
  const base = fakeProvider([[text("one")], [text("two")], [text("three")]]);
  const provider = { ...base, complete: (req: Parameters<typeof base.complete>[0]) => { systems.push(req.system); return base.complete(req); } };
  const orch = await createOrchestrator({ project, provider, tools: {}, write: () => {} });
  await orch.say("turn 0"); await orch.turn();
  await saveProjectFlow(project, { maxReviewRounds: 7, dynamicDispatch: true });
  await orch.say("turn 1"); await orch.turn();
  await saveConfig({ maxReviewRounds: 3, dynamicDispatch: true }); // config changes do not reach a project with an override
  await orch.say("turn 2"); await orch.turn();
  expect(systems).toHaveLength(3);
  expect(systems[0]).toContain("At most 1 review round;");
  expect(systems[0]).not.toContain(DYNAMIC_DISPATCH);
  expect(systems[1]).toContain("At most 7 review rounds;");
  expect(systems[1]).toContain(DYNAMIC_DISPATCH);
  expect(systems[2]).toContain("At most 7 review rounds;");
  expect(systems[2]).toContain(DYNAMIC_DISPATCH); // Shared corrections change between turns.
  expect(rolePrompt("orchestrator", await loadConfig())).toContain("At most 3 review rounds;");
  await saveConfig({ maxReviewRounds: 1, dynamicDispatch: false });
});
