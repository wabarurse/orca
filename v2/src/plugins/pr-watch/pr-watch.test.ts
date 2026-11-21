import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { pluginData } from "../../core/bubbles";
import { createConversation } from "../../core/conversations";
import background from "./background";
import ui from "./ui";
import { gh, readObservations } from "./watch";

const realGh = gh.run;
afterEach(() => { gh.run = realGh; });

type Fake = { state: string; mergeable: string; reviewDecision: string | null; checks: { name: string; conclusion: string }[]; head: string };

async function setup(tasks: unknown[]) {
  const conversation = await createConversation(process.env.ORCA2_HOME!, "t");
  const tasksDir = await pluginData(conversation.id, "tasks", "conversation");
  await Bun.write(join(tasksDir, "tasks.json"), JSON.stringify(tasks));
  const notices: string[] = [];
  const data = (scope: "conversation" | "bubble" | "global") => pluginData(conversation.id, "pr-watch", scope);
  const bctx = { plugin: "pr-watch", conversation: conversation.id, directory: tasksDir, data, notify: async (text: string) => { notices.push(text); }, tell: async () => {}, agents: async () => [] };
  const pctx = { plugin: "pr-watch", conversation: conversation.id, agent: "orchestrator", role: "orchestrator" as const, branch: null, cwd: tasksDir, data };
  const prs: Record<number, Fake> = {};
  const calls: string[][] = [];
  gh.run = async args => {
    calls.push(args);
    const pr = prs[Number(args[2])];
    if (pr === undefined) return { code: 1, stdout: "", stderr: "not found" };
    return { code: 0, stderr: "", stdout: JSON.stringify({ state: pr.state, isDraft: false, mergeable: pr.mergeable, mergeStateStatus: "CLEAN", reviewDecision: pr.reviewDecision, headRefOid: pr.head,
      statusCheckRollup: pr.checks.map(c => ({ __typename: "CheckRun", name: c.name, status: "COMPLETED", conclusion: c.conclusion })) }) };
  };
  const pass = () => background.watchers[0]!.run(bctx);
  return { prs, calls, notices, pass, pctx };
}

const task = (number: number, pr: number | null, status = "pr open") => ({ number, status, branch: `b${number}`, pr: pr === null ? null : { repo: "o/r", number: pr, url: `https://github.com/o/r/pull/${pr}` } });

test("blocked once, cleared once, merged once, never repeated", async () => {
  const { prs, notices, pass, pctx, calls } = await setup([task(1, 7), task(2, null), task(3, 9, "merged")]);
  prs[7] = { state: "OPEN", mergeable: "CONFLICTING", reviewDecision: null, checks: [{ name: "test", conclusion: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }], head: "a1" };
  await pass();
  await pass();
  expect(notices).toEqual(["[pr-blocked] PR #7 (task #1 on b1) cannot merge: conflicts with its base branch; failing checks: test"]);
  expect(calls.every(c => c[2] === "7")).toBe(true);
  expect(calls[0]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid"]);
  expect(await ui.counts[0]!.count(pctx)).toBe(1);
  expect((await ui.tabs[0]!.rows(pctx)).map(r => [r.name, r.status, r.tone])).toEqual([["o/r#7", "blocked", "bad"]]);

  prs[7] = { ...prs[7]!, mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", head: "a2" };
  await pass();
  expect(notices[1]).toBe("[pr-blocked] PR #7 (task #1 on b1) cannot merge: failing checks: test; changes requested");

  prs[7] = { ...prs[7]!, reviewDecision: "APPROVED", checks: [{ name: "test", conclusion: "SUCCESS" }] };
  await pass();
  await pass();
  expect(notices.slice(2)).toEqual(["[pr-updated] PR #7 (task #1 on b1): nothing fixable blocks the merge"]);

  prs[7] = { ...prs[7]!, state: "MERGED" };
  await pass();
  await pass();
  expect(notices.slice(3)).toEqual(["[pr-merged] PR #7 (task #1 on b1) merged"]);
  expect(calls.length).toBe(6);
  expect((await readObservations(await pctx.data("conversation")))["o/r#7"]!.verdict).toBe("merged");
  expect(await ui.counts[0]!.count(pctx)).toBe(0);
});

test("history is recorded silently; a failing gh records nothing", async () => {
  const { prs, notices, pass, pctx } = await setup([task(1, 7), task(2, 8), task(3, 404)]);
  prs[7] = { state: "MERGED", mergeable: "UNKNOWN", reviewDecision: null, checks: [], head: "a" };
  prs[8] = { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: null, checks: [], head: "b" };
  await pass();
  expect(notices).toEqual([]);
  expect(Object.keys(await readObservations(await pctx.data("conversation"))).sort()).toEqual(["o/r#7", "o/r#8"]);
  prs[8] = { ...prs[8]!, state: "CLOSED" };
  await pass();
  expect(notices).toEqual(["[pr-closed] PR #8 (task #2 on b2) closed without merging"]);
});
