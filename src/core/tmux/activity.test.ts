import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { agentActivity } from "./activity";
import { listAgents } from "./liveness";
import { runtime } from "../tools/runtime";
import { recordRuntime } from "../data/knowledge";
import { registerTask, prepareTaskRun } from "../data/tasks";

let home: string, previous: string | undefined, previousPath: string | undefined;
beforeEach(() => { previous = process.env.ORCA_HOME; previousPath = process.env.PATH; home = mkdtempSync(join(tmpdir(), "orca-activity-")); process.env.ORCA_HOME = home; });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; process.env.PATH = previousPath; rmSync(home, { recursive: true, force: true }); });
const project = "p", agent = "worker-spec";
function record(name = agent, patch: Record<string, unknown> = {}) {
  mkdirSync(paths.runs(project), { recursive: true });
  const state = { run: "r1", pid: 12345, role: name.startsWith("reviewer") ? "reviewer" : "worker", state: "running", step: "model", tool: "", ts: "2026-11-02T00:00:00Z", ...patch };
  writeFileSync(join(paths.runs(project), `${name}.json`), JSON.stringify(state));
  mkdirSync(join(paths.project(project), "transcript"), { recursive: true });
  writeFileSync(`${paths.transcript(project, name)}.launch`, String(state.run));
  return state;
}
const live = () => Promise.resolve([{ name: agent, live: true }]);
const options = () => ({ panes: live, processAlive: () => true });
test("running requires a matching current run, live PID and live pane", async () => {
  record(); const status = await agentActivity(project, options());
  expect(status.runningCount).toBe(1); expect(status.agents[0]).toMatchObject({ agent, status: "running", run: "r1", queuedMessages: 0 });
});
test("finished spec writer and its queued follow-ups do not count as running", async () => {
  record("worker-13", { pid: 13 }); record("worker-15", { pid: 15 }); record(agent, { pid: 99, endedAt: "2026-11-02T01:00:00Z" });
  const queue = join(paths.inbox(project), agent); mkdirSync(queue, { recursive: true });
  for (const n of ["1.json", "2.json", "ignore.tmp"]) writeFileSync(join(queue, n), "{}");
  const before = readdirSync(queue);
  const result = await agentActivity(project, { panes: async () => [{ name: "worker-13", live: true }, { name: "worker-15", live: true }, { name: agent, live: false }], processAlive: pid => pid !== 99 });
  expect(result.runningCount).toBe(2);
  expect(result.agents.find(a => a.agent === agent)).toMatchObject({ status: "exited", queuedMessages: 2 });
  expect(readdirSync(queue)).toEqual(before);
});
test("historical context observations never manufacture active agents", async () => {
  await recordRuntime(project, agent, { model: "old", tools: [], system: "", contextTokens: 123 });
  const result = await agentActivity(project, { panes: async () => [], processAlive: () => true });
  expect(result.agents).toEqual([]); expect(result.runningCount).toBe(0);
});
test("task numbers are joined by exact current run, never by a stale agent name", async () => {
  const run = crypto.randomUUID(); record(agent, { run });
  const task = await registerTask(project, { name: "Spec", summary: "Keep ownership", branch: "feat/spec", authorized: true });
  await prepareTaskRun(project, task.id, "feat/spec", { id: run, agent, role: "worker" });
  expect((await agentActivity(project, options())).agents[0]!.task).toEqual({ id: task.id, number: task.number, name: "Spec" });
  writeFileSync(`${paths.transcript(project, agent)}.launch`, crypto.randomUUID());
  expect((await agentActivity(project, options())).agents[0]!.task).toBeUndefined();
});
test("status inspection never bootstraps or repairs missing legacy conversation identity", async () => {
  record(); await registerTask(project, { name: "Legacy", summary: "Retain", branch: "feat/old", authorized: true });
  const identity = join(paths.project(project), ".identity.json"); rmSync(identity);
  const result = await agentActivity(project, options());
  expect(result.runningCount).toBe(1); expect(existsSync(identity)).toBe(false);
  expect(result.errors.join(" ")).toContain("identity is missing");
});
test("retained dead panes with gone PIDs are exited, even without a recorded end", async () => {
  record(); const result = await agentActivity(project, { panes: async () => [{ name: agent, live: false }], processAlive: () => false });
  expect(result.agents[0]!.status).toBe("exited"); expect(result.runningCount).toBe(0);
});
for (const panes of [null, [], [{ name: agent, live: false }]]) test(`live PID without verified pane stays unknown: ${JSON.stringify(panes)}`, async () => {
  record(); const result = await agentActivity(project, { panes: async () => panes, processAlive: () => true });
  expect(result.runningCount).toBeNull(); expect(result.agents[0]!.status).toBe("unknown");
});
test("no known rows plus failed tmux inspection is unknown, not zero", async () => {
  const result = await agentActivity(project, { panes: async () => null });
  expect(result.runningCount).toBeNull(); expect(result.verificationComplete).toBe(false);
});
test("unrecorded panes and invalid records cannot count as running", async () => {
  const first = await agentActivity(project, options()); expect(first.agents[0]!.status).toBe("unknown");
  record(agent, { pid: -1 }); const second = await agentActivity(project, options()); expect(second.runningCount).toBeNull();
});
test("replacement launches and launches changing during inspection stay unknown", async () => {
  record(); writeFileSync(`${paths.transcript(project, agent)}.launch`, "r2");
  expect((await agentActivity(project, options())).agents[0]!.status).toBe("unknown");
  let calls = 0;
  const result = await agentActivity(project, { ...options(), launch: () => ++calls === 1 ? "r1" : "r2" });
  expect(result.agents[0]!.reason).toBe("launch changed during inspection");
});
test("uncertain PID checks and conflicting end records are unknown", async () => {
  record(); expect((await agentActivity(project, { ...options(), processAlive: () => null })).runningCount).toBeNull();
  record(agent, { endedAt: "2026-11-02T01:00:00Z" });
  expect((await agentActivity(project, options())).agents[0]!.status).toBe("unknown");
});
test("unreadable inventory and queue errors are explicit", async () => {
  record(); const inbox = paths.inbox(project); mkdirSync(inbox, { recursive: true }); writeFileSync(join(inbox, agent), "not a queue");
  const result = await agentActivity(project, options());
  expect(result.agents[0]!.queuedMessages).toBeNull(); expect(result.errors.join(" ")).toContain("queued messages");
  rmSync(inbox, { recursive: true }); writeFileSync(inbox, "not an inbox inventory");
  const unavailable = await agentActivity(project, options()); expect(unavailable.runningCount).toBeNull();
});
test("production runtime tool and /agents agree, retaining history separately without rewriting evidence", async () => {
  record(agent, { pid: process.pid });
  const bin = join(home, "bin"); mkdirSync(bin);
  const executable = join(bin, "tmux");
  writeFileSync(executable, `#!/bin/sh\nprintf 'worker-spec\\t0\\n'\n`); chmodSync(executable, 0o755); process.env.PATH = bin;
  await recordRuntime(project, "worker-old", { model: "old", system: "", tools: [], contextTokens: 500 });
  const runFile = join(paths.runs(project), `${agent}.json`), before = readFileSync(runFile);
  const result = JSON.parse(await runtime.run({ action: "status" }, { project, role: "orchestrator", cwd: home }));
  expect(result.runningCount).toBe(1); expect(result.agents).toHaveLength(1);
  expect(result.agents[0]).toMatchObject({ agent, status: "running", queuedMessages: 0 });
  expect(result.agents[0].record).toBeUndefined(); expect(result.contextObservations[0].agent).toBe("worker-old");
  expect(result.applicationSchedules).toBe("not_inspected");
  expect((await listAgents(project))[0]).toMatchObject({ name: agent, live: true, status: "running" });
  expect(readFileSync(runFile)).toEqual(before);
  writeFileSync(executable, `#!/bin/sh\nprintf 'worker-spec\\tinvalid\\n'\n`);
  const unknown = JSON.parse(await runtime.run({ action: "status" }, { project, role: "orchestrator", cwd: home }));
  expect(unknown.runningCount).toBeNull(); expect(unknown.agents[0].status).toBe("unknown");
  writeFileSync(join(paths.runtimeProject(project), "contexts", "worker-old.json"), "invalid");
  writeFileSync(executable, `#!/bin/sh\nprintf 'worker-spec\\t0\\n'\n`);
  const historicalError = JSON.parse(await runtime.run({ action: "status" }, { project, role: "orchestrator", cwd: home }));
  expect(historicalError.runningCount).toBe(1); expect(historicalError.contextObservations).toBeNull();
  expect(historicalError.errors).toContain("historical context observations unavailable");
});
