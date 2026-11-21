import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { backgroundContext } from "../../core/plugins";
import { item, pluginContext, present, toolContext } from "../../core/plugins/testing";
import plugin from "./index";
import ui from "./ui";
import background from "./background";

const tool = item(plugin.tools, 0).tool;
const tab = item(ui.tabs, 0);
const count = item(ui.counts, 0);
const watcher = item(background.watchers, 0);

async function setup() {
  const conversation = await createConversation(mkdtempSync(join(tmpdir(), "orca2-proc-cwd-")), "t");
  const cwd = conversation.directory;
  const ctx = toolContext(conversation.id, cwd, { agent: "worker-a", role: "worker", branch: "a" });
  const pctx = pluginContext(conversation.id, "processes", cwd);
  const told: { to: string; text: string }[] = [];
  const bctx = { ...backgroundContext(conversation.id, "processes", cwd), tell: async (to: string, text: string) => { told.push({ to, text }); } };
  return { conversation, ctx, pctx, bctx, told };
}

const idOf = (text: string): string => present(/started (\w+)/.exec(text)?.[1], "process id");

test("start, wait and output read a finished command and its exit code", async () => {
  const { ctx } = await setup();
  const id = idOf(String(await tool.run({ action: "start", command: "echo one; echo $ORCA_AGENT; pwd; exit 3" }, ctx)));
  const waited = String(await tool.run({ action: "wait", id, timeout_ms: 5000 }, ctx));
  expect(waited).toContain(`${id} exit 3`);
  expect(waited).toContain("worker-a");
  const out = String(await tool.run({ action: "output", id, cursor: 0 }, ctx));
  expect(out.startsWith("one\nworker-a\n")).toBe(true);
  const next = Number(present(/next cursor (\d+)/.exec(out)?.[1], "cursor"));
  expect(String(await tool.run({ action: "output", id, cursor: next }, ctx))).toBe(`[${id} exit 3 0s: echo one; echo $ORCA_AGENT; pwd; exit 3; next cursor ${next}]`);
  expect(String(await tool.run({ action: "list" }, ctx))).toContain(`${id} exit 3`);
});

test("stop kills the process group; a timeout ends it as timed-out; refusals", async () => {
  const { ctx, pctx } = await setup();
  const id = idOf(String(await tool.run({ action: "start", command: "sleep 30 & sleep 30" }, ctx)));
  expect(await count.count(pctx)).toBe(1);
  expect(String(await tool.run({ action: "wait", id, timeout_ms: 300 }, ctx))).toContain("still running");
  expect(String(await tool.run({ action: "stop", id }, ctx))).toContain(`${id} killed`);
  expect(await count.count(pctx)).toBe(0);
  const slow = idOf(String(await tool.run({ action: "start", command: "sleep 30", timeout_ms: 200 }, ctx)));
  expect(String(await tool.run({ action: "wait", id: slow, timeout_ms: 5000 }, ctx))).toContain(`${slow} timed-out`);
  expect(await tool.run({ action: "output", id: "../../x" }, ctx)).toBe("refused: no process ../../x");
  expect(await tool.run({ action: "start", command: "sudo ls" }, ctx)).toBe("refused: sudo is not allowed");
});

test("wait stops when the call is aborted", async () => {
  const { ctx } = await setup();
  const id = idOf(String(await tool.run({ action: "start", command: "sleep 30" }, ctx)));
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  await expect(tool.run({ action: "wait", id }, { ...ctx, signal: abort.signal })).rejects.toThrow();
  await tool.run({ action: "stop", id }, ctx);
});

test("the watcher tells the owner once; the tab shows rows and output; remove kills running ones", async () => {
  const { ctx, pctx, bctx, told } = await setup();
  const done = idOf(String(await tool.run({ action: "start", command: "echo finished" }, ctx)));
  const running = idOf(String(await tool.run({ action: "start", command: "sleep 30" }, ctx)));
  await Bun.sleep(300);
  await watcher.run(bctx);
  await watcher.run(bctx);
  expect(told.length).toBe(1);
  const notice = item(told, 0);
  expect(notice.to).toBe("worker-a");
  expect(notice.text).toContain(`${done} exit 0`);
  expect(notice.text).toContain("finished");
  const rows = await tab.rows(pctx);
  expect(rows.map(r => r.status)).toEqual(["running", "exit 0"]);
  expect(item(await tab.details(item(rows, 1), pctx), 1).lines).toEqual(["finished"]);
  await present(background.remove, "remove hook")(bctx);
  expect(String(await tool.run({ action: "list" }, ctx))).toContain(`${running} killed`);
});
