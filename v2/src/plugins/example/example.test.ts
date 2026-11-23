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

const home = mkdtempSync(join(tmpdir(), "orca2-example-"));

test("pin, list and the tab, count and memory section agree", async () => {
  const conversation = await createConversation(home, "t");
  const tool = item(plugin.tools, 0).tool;
  const ctx = toolContext(conversation.id, home);
  expect(await tool.run({ action: "add", text: "ship on friday" }, ctx)).toBe("pinned p1");
  expect(await tool.run({ action: "list" }, ctx)).toBe("p1: ship on friday");
  const pctx = pluginContext(conversation.id, "example", home);
  expect((await item(ui.tabs, 0).rows(pctx)).map(r => r.name)).toEqual(["ship on friday"]);
  expect(await item(ui.counts, 0).count(pctx)).toBe(1);
  const bctx = backgroundContext(conversation.id, "example", home);
  expect(await present(background.memory, "memory").text(bctx)).toBe("- p1: ship on friday");
});

test("the beforeTool hook blocks an over-long pin", async () => {
  const hook = item(plugin.hooks.beforeTool, 0);
  const pctx = pluginContext("c", "example", home, { data: async () => ({ ok: true, data: home }) });
  const result = await hook({ name: "pin", input: { action: "add", text: "x".repeat(201) } }, pctx);
  expect(result.action).toBe("block");
});

test("the guard rule sends reads of the pins file to the pin tool", () => {
  const rule = plugin.guard[0];
  const command = { program: "cat", args: ["data/example/pins.json"], env: {}, wrappers: [], cwd: home, stdin: false, reads: [], before: [], after: [], inner: [] };
  expect(rule?.test({ tool: "bash", input: {}, command, root: home })).toBe(true);
  expect(rule?.test({ tool: "bash", input: {}, command: { ...command, program: "ls" }, root: home })).toBe(false);
});
