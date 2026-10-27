import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, setTaskAttention, setTaskDependencies, startTaskRun, stopTaskRun } from "./tasks";
import { makeTaskTool } from "../../tools/task";
import type { ToolContext } from "../../tools/registry";

const home = mkdtempSync(join(tmpdir(), "dependencies-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
let project: string, serial = 0;
beforeEach(() => { project = `deps-${serial++}`; mkdirSync(paths.project(project), { recursive: true }); });
const create = (name: string, id?: string) => registerTask(project, { id, name, summary: name, branch: `feat/${name}`, authorized: true });
const bytes = () => readFileSync(`${paths.project(project)}/tasks.json`, "utf8");
async function rejectsUnchanged(id: string, deps: unknown) {
  const before = bytes(), revision = (await getTask(project, id)).revision;
  await expect(setTaskDependencies(project, id, deps)).rejects.toThrow();
  expect(bytes()).toBe(before); expect((await getTask(project, id)).revision).toBe(revision);
}

test("fork/join, canonical stored IDs, history, deliberate clear and omitted ordinary metadata", async () => {
  const a = await create("a", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"), b = await create("b"), c = await create("c"), d = await create("d");
  await setTaskDependencies(project, b.id, [a.id.toLowerCase()]);
  await setTaskDependencies(project, c.id, [a.id]);
  const joined = await setTaskDependencies(project, d.id, [b.id, c.id]);
  expect(joined.revision).toBe(2); expect(joined.history.at(-1)?.kind).toBe("dependencies_updated");
  expect((await getTask(project, b.id)).dependsOn).toEqual([a.id]);
  expect((await listTasks(project)).find(t => t.id === d.id)?.dependsOn).toEqual([b.id, c.id]);
  await setTaskAttention(project, d.id, { kind: "waiting", reason: "ordinary edit" });
  expect((await getTask(project, d.id)).dependsOn).toEqual([b.id, c.id]);
  const cleared = await setTaskDependencies(project, d.id, []);
  expect(cleared.dependsOn).toEqual([]); expect(cleared.status).toBe(joined.status);
  expect(cleared.attention?.kind).toBe("waiting");
});

test("invalid shape, missing/cross-project IDs, duplicates, self and long cycle preserve exact bytes", async () => {
  const a = await create("a"), b = await create("b"), c = await create("c");
  const other = `${project}-other`; mkdirSync(paths.project(other), { recursive: true });
  const foreign = await registerTask(other, { name: "foreign", summary: "foreign", branch: "feat/f", authorized: true });
  for (const deps of [undefined, null, "text", ["bad"], [crypto.randomUUID()], [foreign.id], [a.id.toUpperCase()], [b.id, b.id.toUpperCase()]]) await rejectsUnchanged(a.id, deps);
  await setTaskDependencies(project, a.id, [b.id]); await setTaskDependencies(project, b.id, [c.id]);
  await rejectsUnchanged(c.id, [a.id]);
});

test("full proposed graph rejects unrelated dangling references and cycles, without repair", async () => {
  const a = await create("a"), b = await create("b"), c = await create("c");
  const original = bytes();
  for (const cycle of [false, true]) {
    const store = JSON.parse(original);
    store.tasks[1].dependsOn = [cycle ? c.id : crypto.randomUUID()];
    if (cycle) store.tasks[2].dependsOn = [b.id];
    writeFileSync(`${paths.project(project)}/tasks.json`, JSON.stringify(store));
    await rejectsUnchanged(a.id, []);
  }
});

test("verified merged prerequisites remain referenceable but archived targets immutable", async () => {
  const a = await create("a"), b = await create("b");
  await observeTaskPR(project, a.id, { pr: { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) }, branch: a.branch, state: "MERGED", mergedAt: new Date().toISOString(), ready: false, checks: "passed" });
  expect((await setTaskDependencies(project, b.id, [a.id])).dependsOn).toEqual([a.id]);
  await rejectsUnchanged(a.id, []);
});

test("concurrent opposing edits share project lock: only one commits", async () => {
  const a = await create("a"), b = await create("b");
  const results = await Promise.allSettled([setTaskDependencies(project, a.id, [b.id]), setTaskDependencies(project, b.id, [a.id])]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect((await getTask(project, a.id)).revision + (await getTask(project, b.id)).revision).toBe(3);
});

test("tool explicit inputs, exposure and existing active branch authorization", async () => {
  const a = await create("a"), b = await create("b"), tool = makeTaskTool();
  const ctx = (role: ToolContext["role"] = "orchestrator"): ToolContext => ({ project, role, run: "worker", branch: a.branch, cwd: home });
  const edit = (input: Record<string, unknown>, role: ToolContext["role"] = "orchestrator") => tool.run({ action: "dependencies", ...input }, ctx(role));
  for (const input of [{ taskId: a.id }, { dependsOn: [] }, { taskId: a.id, dependsOn: null }]) expect(await edit(input)).toStartWith("refused:");
  expect(await edit({ taskId: a.id, dependsOn: [b.id] }, "worker")).toContain("active agent");
  await prepareTaskRun(project, a.id, a.branch, { id: "worker", role: "worker", agent: "worker-a" }); await startTaskRun(project, "worker");
  expect(JSON.parse(await edit({ taskId: a.id, dependsOn: [b.id] }, "worker")).dependsOn).toEqual([b.id]);
  expect(await edit({ taskId: b.id, dependsOn: [] }, "worker")).toContain("active agent");
  expect(JSON.parse(await tool.run({ action: "get", taskId: a.id }, ctx())).dependsOn).toEqual([b.id]);
  expect(JSON.parse(await tool.run({ action: "list" }, ctx())).find((t: { id: string }) => t.id === a.id).dependsOn).toEqual([b.id]);
  await stopTaskRun(project, "worker", "waiting", "done");
  expect(await edit({ taskId: a.id, dependsOn: [] }, "worker")).toContain("active agent");
  expect(JSON.parse(await edit({ taskId: a.id, dependsOn: [] })).dependsOn).toEqual([]);
  expect(tool.spec.input_schema.properties).toHaveProperty("dependsOn");
});
