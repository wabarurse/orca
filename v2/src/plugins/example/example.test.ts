import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { pluginData } from "../../core/bubbles";
import plugin from "./index";
import ui from "./ui";
import background from "./background";

const home = mkdtempSync(join(tmpdir(), "orca2-example-"));
beforeAll(() => { process.env.ORCA2_HOME = home; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

test("pin, list and the tab, count and memory section agree", async () => {
  const conversation = await createConversation(home, "t");
  const data = join(home, "conversations", conversation.id, "data");
  const tool = plugin.tools[0]!.tool;
  const ctx = { conversation: conversation.id, agent: "orchestrator", data } as Parameters<typeof tool.run>[1];
  expect(await tool.run({ action: "add", text: "ship on friday" }, ctx)).toBe("pinned p1");
  expect(await tool.run({ action: "list" }, ctx)).toBe("p1: ship on friday");
  const pctx = { plugin: "example", conversation: conversation.id, agent: "orchestrator", role: "orchestrator" as const, cwd: home, data: (scope: "conversation" | "bubble" | "global") => pluginData(conversation.id, "example", scope) };
  expect((await ui.tabs[0]!.rows(pctx)).map(r => r.name)).toEqual(["ship on friday"]);
  expect(await ui.counts[0]!.count(pctx)).toBe(1);
  const bctx = { plugin: "example", conversation: conversation.id, directory: home, data: pctx.data, notify: async () => {} };
  expect(await background.memory!.text(bctx)).toBe("- p1: ship on friday");
});

test("the beforeTool hook blocks an over-long pin", async () => {
  const hook = plugin.hooks.beforeTool[0]!;
  const result = await hook({ name: "pin", input: { action: "add", text: "x".repeat(201) } }, {} as never);
  expect(result.action).toBe("block");
});
