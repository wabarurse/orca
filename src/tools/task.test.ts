import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config";
import { getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, startTaskRun, stopTaskRun, type PRObservation } from "../tasks";
import { rolePrompt } from "../prompts";
import { defaults } from "../config";
import { makeTaskTool } from "./task";
import { registry, toolsFor, type ToolContext } from "./index";

const home = mkdtempSync(join(tmpdir(), "task-tool-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
let n = 0, project: string;
let snapshot: PRObservation | null;
let repository: string | null, localHead: string | null;
let beforeHead: (() => Promise<void>) | undefined;
const head = "a".repeat(40);
const observed = (): PRObservation => ({ pr: { repository: "o/r", number: 2, url: "https://github.com/o/r/pull/2", head }, branch: "feat/x", state: "OPEN", ready: true, checks: "not_configured" });
const tool = makeTaskTool({ repo: async () => repository, pr: async () => snapshot, head: async () => { await beforeHead?.(); return localHead; } });
const ctx = (role: ToolContext["role"] = "orchestrator", run?: string, branch = "feat/x"): ToolContext => ({ project, role, run, branch, cwd: home });
beforeEach(() => { project = `t-${n++}`; mkdirSync(paths.project(project), { recursive: true }); snapshot = observed(); repository = "o/r"; localHead = head; beforeHead = undefined; });
async function reviewer(reviewMode?: "review" | "watch-ci") {
  const t = await registerTask(project, { name: "Task", summary: "Summary", branch: "feat/x", authorized: true });
  await prepareTaskRun(project, t.id, t.branch, { id: "reviewer", role: "reviewer", agent: "reviewer-feat-x", ...(reviewMode ? { reviewMode } : {}) });
  await startTaskRun(project, "reviewer"); return t;
}
const record = (taskId?: string) => tool.run({ action: "pr", taskId, repository: "o/r", number: 2 }, ctx("reviewer", "reviewer"));
const validate = (extra: Record<string, unknown> = {}, context = ctx("reviewer", "reviewer")) => tool.run({ action: "ready", validated: true, validation: "bun test/check/build and code review passed on this head", ...extra }, context);

test("task tool is explicit structured JSON, role-scoped; no new scheduling/publishing roles", async () => {
  for (const tools of Object.values(toolsFor)) expect(tools).toContain("task"); expect(registry.task).toBeDefined();
  expect(await tool.run({ action: "register", name: "Task", summary: "Summary", branch: "feat/x", authorized: true }, ctx("worker", "worker"))).toContain("only the orchestrator");
  expect(await tool.run({ action: "register", name: "Task", summary: "Summary", branch: "feat/x" }, ctx())).toContain("authorization");
  const task = JSON.parse(await tool.run({ action: "register", name: "Task", summary: "Summary", branch: "feat/x", authorized: true }, ctx()));
  expect(task.status).toBe("queued");
  expect(JSON.parse(await tool.run({ action: "list" }, ctx()))).toEqual(await listTasks(project));
  expect(JSON.parse(await tool.run({ action: "get", taskId: task.id }, ctx())).id).toBe(task.id);
  expect(rolePrompt("orchestrator", { ...defaults, maxReviewRounds: 0 })).toContain('spawn the reviewer with "watch ci" (no code review)');
  expect(rolePrompt("reviewer", defaults)).toContain("Review-only never asserts readiness");
});

test("PR creation/no CI is not ready; active reviewer explicitly validates verified exact clean head", async () => {
  const t = await reviewer();
  expect(JSON.parse(await record()).status).toBe("reviewing");
  expect(await validate({ validated: false })).toContain("not validated");
  expect(await validate({ validation: "" })).toContain("validation is required");
  expect((await getTask(project, t.id)).status).toBe("reviewing");
  const ready = JSON.parse(await validate()); expect(ready.status).toBe("ready_to_merge"); expect(ready.readiness.head).toBe(head);
  expect(ready.readiness.checks).toBe("not_configured");
  expect(await validate({}, ctx("orchestrator"))).toContain("taskId");
  expect(await validate({ taskId: t.id }, ctx("orchestrator"))).toContain("only a reviewer");
});

test("duplicate registration on a PR branch guides corrections to the existing task without changing it", async () => {
  const t = await reviewer(); await record();
  const before = await getTask(project, t.id);
  const result = await tool.run({ action: "register", name: "Fix the PR", summary: "Correct the existing change", branch: t.branch, authorized: true }, ctx());
  expect(result).toStartWith("refused:");
  expect(result).toContain("same unmerged pr");
  expect(result).toContain("resume its existing taskId and branch without registering again");
  expect(result).toContain("separate work needs a new branch");
  expect(JSON.parse(await tool.run({ action: "list" }, ctx())).map((row: { id: string }) => row.id)).toEqual([t.id]);
  expect(JSON.parse(await tool.run({ action: "get", taskId: t.id }, ctx()))).toEqual(before);
  const separate = JSON.parse(await tool.run({ action: "register", name: "Separate work", summary: "Independent feature", branch: "feat/separate", authorized: true }, ctx()));
  expect(separate.id).not.toBe(t.id);
  expect(separate.branch).toBe("feat/separate");
  expect(tool.spec.description).toContain("resume its taskId and branch without registering again, even after a ready report");
});

test("workers and unrelated/stale reviewer runs cannot write readiness or PR identities", async () => {
  const t = await reviewer();
  expect(await tool.run({ action: "pr", taskId: t.id, repository: "o/r", number: 2 }, ctx("worker", "unknown"))).toContain("active agent");
  expect(await tool.run({ action: "attention", taskId: t.id, kind: "blocked", reason: "x" }, ctx("reviewer", "reviewer", "different"))).toContain("active agent");
  await record(); await stopTaskRun(project, "reviewer", "waiting", "Reported");
  expect(await validate()).toContain("active agent");
  expect((await getTask(project, t.id)).status).not.toBe("ready_to_merge");
});

test("unknown GitHub, non-origin repo, dirty/mismatched HEAD, draft/conflicts/pending checks fail closed", async () => {
  const t = await reviewer();
  repository = "other/r"; expect(await record()).toContain("match project origin");
  repository = "o/r"; snapshot = null; expect(await record()).toContain("lookup failed/unknown");
  expect((await getTask(project, t.id)).pr).toBeUndefined();
  snapshot = observed(); await record();
  for (const invalid of [null, "b".repeat(40)]) { localHead = invalid; expect(await validate()).toContain("clean HEAD"); }
  localHead = head; snapshot = { ...observed(), ready: false, checks: "pending" };
  expect(await validate()).toContain("not validated ready");
  expect((await getTask(project, t.id)).readiness).toBeUndefined(); expect(await listTasks(project)).toHaveLength(1);
});

test("concurrent PR head change during readiness validation rejects stale results", async () => {
  const t = await reviewer(); await record();
  beforeHead = async () => { await observeTaskPR(project, t.id, { ...observed(), pr: { ...observed().pr, head: "b".repeat(40) } }); };
  expect(await validate()).toContain("changed during validation");
  expect((await getTask(project, t.id)).readiness).toBeUndefined();
});

test("ready attempt observes a real merge, closed PR is retained, attention does not consume or auto-continue", async () => {
  const t = await reviewer(); await record();
  snapshot = { ...observed(), state: "CLOSED", ready: false };
  expect(await validate()).toContain("not validated ready");
  expect((await getTask(project, t.id)).attention?.kind).toBe("closed"); expect(await listTasks(project)).toHaveLength(1);
  const out = JSON.parse(await tool.run({ action: "attention", taskId: t.id, kind: "cancelled", reason: "User stopped it" }, ctx()));
  expect(out.attention.kind).toBe("cancelled");
  snapshot = { ...observed(), state: "MERGED", ready: false, mergedAt: new Date().toISOString() };
  await record(); expect(await listTasks(project)).toEqual([]); expect((await getTask(project, t.id)).archive?.reason).toBe("merged");
});

test("failed explicit PR refresh invalidates previously validated readiness without removing the task", async () => {
  const t = await reviewer(); await record(); await validate();
  snapshot = null;
  expect(await validate()).toContain("lookup failed/unknown");
  const retained = await getTask(project, t.id);
  expect(retained.readiness).toBeUndefined(); expect(retained.attention?.kind).toBe("unknown"); expect(await listTasks(project)).toHaveLength(1);
});


test("editorial watch-ci with no hosted checks still needs exact-head bounded evidence, not a code-review round", async () => {
  const t = await reviewer("watch-ci");
  await record();
  expect((await getTask(project, t.id)).readiness).toBeUndefined();
  expect((await listTasks(project))[0]?.review).toEqual({ rounds: 0, unknown: false, ci: true });
  expect(await validate({ validation: "" })).toContain("validation is required");
  const validation = "README wording only: checked requested sentences and local link targets against this clean PR head; no executable or instruction changes. App suite/complexity inapplicable.";
  for (const invalid of [null, "b".repeat(40)]) {
    localHead = invalid;
    expect(await validate({ validation })).toContain("clean HEAD");
  }
  localHead = head;
  const ready = JSON.parse(await validate({ validation }));
  expect(ready.status).toBe("ready_to_merge");
  expect(ready.readiness).toMatchObject({ head, validation, checks: "not_configured" });
  expect((await listTasks(project))[0]?.review).toEqual({ rounds: 0, unknown: false, ci: true });
});
