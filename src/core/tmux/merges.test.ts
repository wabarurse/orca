import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { getTask, observeTaskPR, prepareTaskRun, registerTask, startTaskRun } from "../data/tasks";
import { observe } from "../data/inbox";
import { mergeWatcher } from "./merges";
import type { PRObservation } from "../../protocol/task";
let root: string, previous: string | undefined;
const project = "p", head = "a".repeat(40);
const observation = (state: PRObservation["state"] = "MERGED"): PRObservation => ({
  pr: { repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", head }, branch: "feat/work", state,
  ...(state === "MERGED" ? { mergedAt: "2026-10-30T15:00:00Z" } : {}), ready: false, checks: "unknown",
});
beforeEach(() => { previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-merge-notify-")); process.env.ORCA_HOME = root; mkdirSync(paths.project(project), { recursive: true }); });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
async function linked() {
  const task = await registerTask(project, { name: "Work", summary: "Requested change", branch: "feat/work", authorized: true });
  return observeTaskPR(project, task.id, observation("OPEN"));
}
const messages = () => readdirSync(join(paths.inbox(project), "orchestrator")).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(paths.inbox(project), "orchestrator", n), "utf8")));
test("merge notification updates the task once and preserves active ownership, files and branches", async () => {
  const task = await linked();
  await prepareTaskRun(project, task.id, task.branch, { id: "running", role: "worker", agent: "worker-feat-work" }); await startTaskRun(project, "running");
  const workspace = join(root, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "draft"), "keep");
  let queries = 0;
  const opts = { repo: async () => "o/r", pr: async () => { queries++; return observation(); }, everyMs: 0 };
  expect(await mergeWatcher(opts)(project)).toEqual([7]);
  expect((await getTask(project, task.id)).archive?.reason).toBe("merged");
  expect((await getTask(project, task.id)).runs.at(-1)?.state).toBe("started");
  expect(readFileSync(join(workspace, "draft"), "utf8")).toBe("keep");
  expect(messages()).toHaveLength(1); expect(messages()[0].text).toContain("[pr-merged]");
  expect(await mergeWatcher(opts)(project)).toEqual([]); // separate process/client equivalent
  expect(messages()).toHaveLength(1); expect(queries).toBe(1);
  expect(existsSync(`${paths.transcript(project, "worker-feat-work")}.cancel`)).toBe(false);
});
test("an archived task drains a notification missed between archive and delivery", async () => {
  const task = await linked();
  await observe(project, "merge:o/r#7", observation().mergedAt, "[pr-merged] observed merge", { defer: true });
  await observeTaskPR(project, task.id, observation());
  await mergeWatcher({ repo: async () => "o/r", pr: async () => { throw Error("must not re-query archived PR"); } })(project);
  expect(messages()).toHaveLength(1);
});
test("conversations with no linked PRs perform no remote queries", async () => {
  let calls = 0; await mergeWatcher({ repo: async () => { calls++; return "o/r"; } })(project); expect(calls).toBe(0);
});
test("unknown, closed and foreign/mismatched observations never claim a merge", async () => {
  const task = await linked();
  for (const result of [null, observation("CLOSED"), { ...observation(), branch: "other" }]) {
    await mergeWatcher({ repo: async () => "o/r", pr: async () => result })(project).catch(() => {});
    expect((await getTask(project, task.id)).archive).toBeUndefined();
  }
  await mergeWatcher({ repo: async () => "other/repo", pr: async () => { throw Error("foreign query"); } })(project);
  expect((await getTask(project, task.id)).archive).toBeUndefined();
});
test("watcher coalesces overlapping checks and respects its polling interval", async () => {
  await linked(); let calls = 0, now = 0;
  const gate = Promise.withResolvers<PRObservation>();
  const check = mergeWatcher({ now: () => now, everyMs: 30_000, repo: async () => "o/r", pr: async () => { calls++; return gate.promise; } });
  const first = check(project); await Bun.sleep(15); expect(await check(project)).toEqual([]);
  gate.resolve(observation("OPEN")); await first; expect(calls).toBe(1);
  now = 29_999; await check(project); expect(calls).toBe(1);
  now = 30_000; await check(project); expect(calls).toBe(2);
});

test("historical merged tasks are retained without replaying old merge notifications", async () => {
  const task = await linked(); await observeTaskPR(project, task.id, observation());
  expect(await mergeWatcher({ repo: async () => "o/r" })(project)).toEqual([]);
  expect(existsSync(join(paths.inbox(project), "orchestrator"))).toBe(false);
});
