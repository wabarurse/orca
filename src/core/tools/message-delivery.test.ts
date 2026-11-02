import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { existingTasks, prepareTaskRun, registerTask, setTaskAttention } from "../data/tasks";
import { execution } from "../data/projects/lifecycle";
import type { AgentActivity } from "../tmux";
import { messageReceipt } from "./message-delivery";
const project = "p", agent = "worker-fix", inputId = "follow-up";
let home: string, previous: string | undefined;
beforeEach(() => { previous = process.env.ORCA_HOME; home = mkdtempSync(`${tmpdir()}/orca-message-receipt-`); process.env.ORCA_HOME = home; mkdirSync(paths.project(project), { recursive: true }); });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(home, { recursive: true, force: true }); });
const row = (status: AgentActivity["status"], state: "running" | "reported" = "running"): AgentActivity => ({ agent, status, reason: "fixture", run: "run", pid: 123,
  record: { run: "run", pid: 123, role: "worker", branch: "fix", state, step: "model", tool: "", ts: "today" }, queuedMessages: 1 });
const receipt = (agentRow: AgentActivity) => messageReceipt(project, agent, inputId, async () => ({ observedAt: "now", agents: [agentRow] })).then(JSON.parse);
test("messages queued for exited workers explicitly deny execution and give a same-branch resume hint", async () => {
  const result = await receipt(row("exited"));
  expect(result).toMatchObject({ enqueued: true, agentStarted: false, processingConfirmed: false, recipientStatus: "exited", acceptsFollowUps: false });
  expect(result.resumeHint).toMatchObject({ tool: "spawn", branch: "fix", role: "worker" });
  expect(result.resumeHint.prompt).toContain(inputId);
});
test("even live worker queue acceptance does not assert processing", async () => {
  const result = await receipt(row("running"));
  expect(result.acceptsFollowUps).toBe(true); expect(result.processingConfirmed).toBe(false); expect(result.resumeHint).toBeUndefined();
});
test("reported workers about to exit are not advertised as accepting follow-ups", async () => {
  const result = await receipt(row("running", "reported"));
  expect(result.finishing).toBe(true); expect(result.acceptsFollowUps).toBe(false); expect(result.resumeHint.tool).toBe("spawn");
});
test("a reported worker supervising background commands can still receive messages", async () => {
  const agentRow = row("running", "reported"); agentRow.record!.step = "waiting for background commands";
  expect((await receipt(agentRow)).acceptsFollowUps).toBe(true);
});
test("inspection failure cannot turn successful queue publication into a retryable delivery error", async () => {
  const result = JSON.parse(await messageReceipt(project, agent, inputId, async () => { throw new Error("offline"); }));
  expect(result.enqueued).toBe(true); expect(result.recipientStatus).toBe("unknown"); expect(result.resumeHint).toBeUndefined();
  const stale = row("unknown", "reported");
  expect((await receipt(stale)).resumeHint).toBeUndefined();
});
test("stopped work never receives resume instructions", async () => {
  await execution.stop(project);
  const result = await receipt(row("exited"));
  expect(result.projectStopped).toBe(true); expect(result.resumeHint).toBeUndefined(); expect(result.nextAction).toContain("fresh human authorization");
});
test("same-run task ownership is preserved in resume hints without mutating task records", async () => {
  const task = await registerTask(project, { name: "Fix", summary: "authorized", branch: "fix", authorized: true });
  await prepareTaskRun(project, task.id, "fix", { id: "run", agent, role: "worker" });
  const before = JSON.stringify(existingTasks(project));
  const result = await receipt(row("exited")); expect(result.resumeHint.taskId).toBe(task.id);
  expect(JSON.stringify(existingTasks(project))).toBe(before);
});
test("cancelled task and mismatched recipient identity cannot get a resume hint", async () => {
  const task = await registerTask(project, { name: "Cancelled", summary: "Retain", branch: "fix", authorized: true });
  await prepareTaskRun(project, task.id, "fix", { id: "run", agent, role: "worker" });
  await setTaskAttention(project, task.id, { kind: "cancelled", reason: "User stopped this task" });
  expect((await receipt(row("exited"))).resumeHint).toBeUndefined();
  const agentRow = row("exited"); agentRow.record!.branch = "another-owner";
  expect((await receipt(agentRow)).resumeHint).toBeUndefined();
});
