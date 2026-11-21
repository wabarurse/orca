import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { pluginData } from "../../core/bubbles";
import { createConversation } from "../../core/conversations";
import { backgroundContext } from "../../core/plugins";
import { item, pluginContext, present, recordingHost, toolContext, unwrap } from "../../core/plugins/testing";
import background from "./background";
import plugin, { gh, onSpawn } from "./index";
import { readTasks } from "./store";
import ui from "./ui";

const realGh = gh.run;
afterEach(() => { gh.run = realGh; });
const tool = item(plugin.tools, 0).tool;
const tab = item(ui.tabs, 0);
const count = item(ui.counts, 0);

async function setup() {
  const conversation = await createConversation(present(process.env.ORCA2_HOME, "ORCA2_HOME"), "t");
  const dir = unwrap(await pluginData(conversation.id, "tasks", "conversation"));
  const data = join(dir, "..");
  const orch = toolContext(conversation.id, dir, { data });
  const worker = (branch: string) => toolContext(conversation.id, dir, { data, role: "worker", agent: `worker-${branch}`, branch });
  return { dir, orch, worker, pctx: pluginContext(conversation.id, "tasks", dir) };
}

const tasksIn = async (dir: string) => unwrap(await readTasks(dir));

test("create, depends_on, update and the refusals", async () => {
  const { dir, orch, worker } = await setup();
  expect(await tool.run({ action: "create", name: "login fix", branch: "fix-login" }, orch)).toBe("created #1 login fix [queued] branch fix-login");
  expect(await tool.run({ action: "create", name: "docs", depends_on: [1] }, orch)).toBe("created #2 docs [queued] after #1");
  expect(await tool.run({ action: "update", task: 1, depends_on: [2] }, orch)).toBe("refused: depends_on would make a cycle");
  expect(await tool.run({ action: "create", name: "x", depends_on: [9] }, orch)).toStartWith("refused:");
  expect(await tool.run({ action: "create", name: "x" }, worker("fix-login"))).toBe("refused: only the orchestrator can create tasks");
  expect(await tool.run({ action: "update", task: 2, status: "working" }, worker("fix-login"))).toBe("refused: #2 is not this branch's task");
  expect(await tool.run({ action: "update", status: "waiting", notes: "needs a token" }, worker("fix-login"))).toStartWith("updated #1 login fix [waiting]");
  expect(await tool.run({ action: "update", task: 1, status: "done" }, orch)).toStartWith("refused: status is one of");
  const first = item(await tasksIn(dir), 0);
  expect(first.notes[0]).toEndWith("worker-fix-login: needs a token");
  expect(await tool.run({ action: "list" }, orch)).toBe("#1 login fix [waiting] branch fix-login\n#2 docs [queued] after #1");
});

test("pr is verified with gh and refused when gh fails or the branch differs", async () => {
  const { orch, worker } = await setup();
  await tool.run({ action: "create", name: "login fix", branch: "fix-login" }, orch);
  const calls: string[][] = [];
  gh.run = async args => { calls.push(args); return { code: 1, stdout: "", stderr: "no pull requests found\n" }; };
  expect(await tool.run({ action: "pr", repository: "o/r", number: 7 }, worker("fix-login"))).toBe("refused: gh pr view failed: no pull requests found");
  expect(calls[0]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "state,url,headRefName"]);
  gh.run = async () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/o/r/pull/7", headRefName: "other" }), stderr: "" });
  expect(await tool.run({ action: "pr", task: 1, repository: "o/r", number: 7 }, orch)).toBe("refused: PR #7 is on other, task #1 on fix-login");
  gh.run = async () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/o/r/pull/7", headRefName: "fix-login" }), stderr: "" });
  expect(await tool.run({ action: "pr", repository: "o/r", number: 7 }, worker("fix-login"))).toBe("linked #1 login fix [pr open] branch fix-login PR o/r#7");
  expect(await tool.run({ action: "pr", task: 1, repository: "nope", number: 7 }, orch)).toStartWith("refused: pr needs");
});

test("a successful subagent spawn registers its branch's task, a second marks it working, failures do nothing", async () => {
  const { dir, orch, pctx } = await setup();
  const spawn = (branch: string, ok: boolean) => onSpawn({ name: "subagent", input: { action: "spawn", branch, brief: "## Fix the login redirect\nDetails…" } }, { ok, content: "worker-x started" }, pctx);
  expect(await spawn("fix-login", true)).toEqual({ ok: true, content: "worker-x started" });
  await spawn("broken", false);
  let tasks = await tasksIn(dir);
  expect(tasks.map(t => [t.number, t.name, t.branch, t.status])).toEqual([[1, "Fix the login redirect", "fix-login", "working"]]);
  await tool.run({ action: "update", task: 1, status: "waiting" }, orch);
  await spawn("fix-login", true);
  tasks = await tasksIn(dir);
  expect(tasks.length).toBe(1);
  expect(item(tasks, 0).status).toBe("working");
  await onSpawn({ name: "subagent", input: { action: "list" } }, { ok: true, content: "no subagents" }, pctx);
  expect((await tasksIn(dir)).length).toBe(1);
});

test("outline, details, count, close action and the memory section", async () => {
  const { orch, pctx } = await setup();
  await tool.run({ action: "create", name: "api", branch: "api" }, orch);
  await tool.run({ action: "create", name: "client", depends_on: [1] }, orch);
  await tool.run({ action: "create", name: "docs", depends_on: [1, 2] }, orch);
  await tool.run({ action: "create", name: "e2e", depends_on: [2] }, orch);
  await tool.run({ action: "create", name: "release", depends_on: [1] }, orch);
  expect((await tab.rows(pctx)).map(r => `${r.name} | ${r.status} | ${r.info}`)).toEqual([
    "#1 api | queued | api", "├─ #2 client | queued | ", "│  └─ #4 e2e | queued | ", "├─ #3 docs | queued | +#2", "└─ #5 release | queued | ",
  ]);
  const details = await tab.details({ id: "1", name: "", status: "", info: "", tone: "normal" }, pctx);
  expect(present(details.find(s => s.title === "Depends on"), "Depends on").lines[1]).toBe("Unblocks: #2 client, #3 docs, #5 release");
  expect(await count.count(pctx)).toBe(5);
  const { host, notes } = recordingHost(pctx, { pick: null, input: null, confirm: true });
  await item(tab.actions, 0).run({ id: "5", name: "", status: "", info: "", tone: "normal" }, host);
  expect(notes).toEqual(["closed task #5"]);
  expect(await count.count(pctx)).toBe(4);
  const bctx = backgroundContext(pctx.conversation, "tasks", pctx.cwd);
  expect(await present(background.memory, "memory").text(bctx)).toBe([
    "- #1 api [queued] branch api", "- #2 client [queued] after #1", "- #3 docs [queued] after #1, #2", "- #4 e2e [queued] after #2",
  ].join("\n"));
  expect(present(ui.folds.task, "task fold").items({ action: "create", name: "api" }, { ok: true, text: "created #1" })).toEqual(["api"]);
});
