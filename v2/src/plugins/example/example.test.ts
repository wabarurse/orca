import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { pluginData } from "../../core/bubbles";
import plugin from "./index";
import ui from "./ui";
import background from "./background";
import { fakeProvider } from "../../test/fake-provider";
import type { PluginContext } from "../../core/plugins";
import type { ToolContext } from "../../core/tools/registry";

const home = mkdtempSync(join(tmpdir(), "orca2-example-"));
beforeAll(() => { process.env.ORCA2_HOME = home; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

test("pin, list and the tab, count and memory section agree", async () => {
  const conversation = await createConversation(home, "t");
  const data = join(home, "conversations", conversation.id, "data");
  const tool = plugin.tools[0]?.tool;
  if (tool === undefined) throw new Error("the example plugin has no tool");
  const ctx: ToolContext = { conversation: conversation.id, agent: "orchestrator", role: "orchestrator", branch: null, cwd: home, data, trusted: false, pluginSkills: [], guard: [],
    callId: "c1", signal: new AbortController().signal, model: "fake-model", provider: fakeProvider([]), settings: null,
    runtime: { spawn: async () => { throw new Error("no spawn"); }, agents: async () => [], stop: async () => "", confirm: async () => false } };
  expect(await tool.run({ action: "add", text: "ship on friday" }, ctx)).toBe("pinned p1");
  expect(await tool.run({ action: "list" }, ctx)).toBe("p1: ship on friday");
  const pctx: PluginContext = { plugin: "example", conversation: conversation.id, agent: "orchestrator", role: "orchestrator", cwd: home, data: scope => pluginData(conversation.id, "example", scope) };
  expect((await ui.tabs[0]?.rows(pctx))?.map(r => r.name)).toEqual(["ship on friday"]);
  expect(await ui.counts[0]?.count(pctx)).toBe(1);
  const bctx = { plugin: "example", conversation: conversation.id, directory: home, data: pctx.data, notify: async () => {} };
  expect(await background.memory?.text(bctx)).toBe("- p1: ship on friday");
});

test("the beforeTool hook blocks an over-long pin", async () => {
  const hook = plugin.hooks.beforeTool[0];
  const pctx: PluginContext = { plugin: "example", conversation: "c", agent: "orchestrator", role: "orchestrator", cwd: home, data: async () => ({ ok: true, data: home }) };
  const result = await hook?.({ name: "pin", input: { action: "add", text: "x".repeat(201) } }, pctx);
  expect(result?.action).toBe("block");
});

test("the guard rule sends reads of the pins file to the pin tool", () => {
  const rule = plugin.guard[0];
  const command = { program: "cat", args: ["data/example/pins.json"], env: {}, wrappers: [], cwd: home, stdin: false, reads: [], before: [], after: [], inner: [] };
  expect(rule?.test({ tool: "bash", input: {}, command, root: home })).toBe(true);
  expect(rule?.test({ tool: "bash", input: {}, command: { ...command, program: "ls" }, root: home })).toBe(false);
});
