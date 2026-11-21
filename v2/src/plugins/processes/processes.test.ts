import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { pluginData } from "../../core/bubbles";
import { pending } from "../../core/inbox";
import plugin from "./index";
import ui from "./ui";
import background from "./background";

const tool = plugin.tools[0]!.tool;
type Ctx = Parameters<typeof tool.run>[1];

async function setup() {
  const conversation = await createConversation(mkdtempSync(join(tmpdir(), "orca2-proc-cwd-")), "t");
  const dataRoot = join(process.env.ORCA2_HOME!, "conversations", conversation.id, "data");
  const cwd = conversation.directory;
  const ctx = { conversation: conversation.id, agent: "worker-a", role: "worker", cwd, data: dataRoot, signal: new AbortController().signal } as Ctx;
  const data = (scope: "conversation" | "bubble" | "global") => pluginData(conversation.id, "processes", scope);
  const pctx = { plugin: "processes", conversation: conversation.id, agent: "orchestrator", role: "orchestrator" as const, branch: null, cwd, data };
  const told: { to: string; text: string }[] = [];
  const bctx = { plugin: "processes", conversation: conversation.id, directory: cwd, data, notify: async () => {}, tell: async (to: string, text: string) => { told.push({ to, text }); }, agents: async () => [] };
  return { conversation, ctx, pctx, bctx, told };
}

const idOf = (text: string): string => /started (\w+)/.exec(text)![1]!;

test("start, wait and output read a finished command and its exit code", async () => {
  const { ctx } = await setup();
  const id = idOf(String(await tool.run({ action: "start", command: "echo one; echo $ORCA_AGENT; pwd; exit 3" }, ctx)));
  const waited = String(await tool.run({ action: "wait", id, timeout_ms: 5000 }, ctx));
  expect(waited).toContain(`${id} exit 3`);
  expect(waited).toContain("worker-a");
  const out = String(await tool.run({ action: "output", id, cursor: 0 }, ctx));
  expect(out.startsWith("one\nworker-a\n")).toBe(true);
  const next = Number(/next cursor (\d+)/.exec(out)![1]);
  expect(String(await tool.run({ action: "output", id, cursor: next }, ctx))).toBe(`[${id} exit 3 0s: echo one; echo $ORCA_AGENT; pwd; exit 3; next cursor ${next}]`);
  expect(String(await tool.run({ action: "list" }, ctx))).toContain(`${id} exit 3`);
});

test("stop kills the process group; a timeout ends it as timed-out; refusals", async () => {
  const { ctx, pctx } = await setup();
  const id = idOf(String(await tool.run({ action: "start", command: "sleep 30 & sleep 30" }, ctx)));
  expect(await ui.counts[0]!.count(pctx)).toBe(1);
  expect(String(await tool.run({ action: "wait", id, timeout_ms: 300 }, ctx))).toContain("still running");
  expect(String(await tool.run({ action: "stop", id }, ctx))).toContain(`${id} killed`);
  expect(await ui.counts[0]!.count(pctx)).toBe(0);
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
  await background.watchers[0]!.run(bctx);
  await background.watchers[0]!.run(bctx);
  expect(told.length).toBe(1);
  expect(told[0]!.to).toBe("worker-a");
  expect(told[0]!.text).toContain(`${done} exit 0`);
  expect(told[0]!.text).toContain("finished");
  const rows = await ui.tabs[0]!.rows(pctx);
  expect(rows.map(r => r.status)).toEqual(["running", "exit 0"]);
  expect((await ui.tabs[0]!.details(rows[1]!, pctx))[1]!.lines).toEqual(["finished"]);
  await background.remove!(bctx);
  expect(String(await tool.run({ action: "list" }, ctx))).toContain(`${running} killed`);
});
