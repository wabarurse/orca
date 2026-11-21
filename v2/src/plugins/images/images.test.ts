import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { pluginData } from "../../core/bubbles";
import { saveImage } from "../../core/images";
import type { UiHost } from "../../core/plugins";
import { png } from "../../test/image-fixture";
import plugin from "./index";
import ui from "./ui";

const home = mkdtempSync(join(tmpdir(), "orca2-images-"));
beforeAll(() => { process.env.ORCA2_HOME = home; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

const tool = plugin.tools[0]!.tool;
type Ctx = Parameters<typeof tool.run>[1];

async function setup() {
  const conversation = await createConversation(home, "i");
  const ctx = { conversation: conversation.id, agent: "worker-x", role: "worker" } as Ctx;
  const pctx = { plugin: "images", conversation: conversation.id, agent: "orchestrator", role: "orchestrator" as const, branch: null, cwd: home,
    data: (scope: "conversation" | "bubble" | "global") => pluginData(conversation.id, "images", scope) };
  return { conversation: conversation.id, ctx, pctx };
}

test("list and show go through the core image store; unknown ids are refused", async () => {
  const { conversation, ctx } = await setup();
  expect(await tool.run({ action: "list" }, ctx)).toBe("no images");
  const id = await saveImage(conversation, png(3, 2));
  expect(String(await tool.run({ action: "list" }, ctx))).toMatch(new RegExp(`^${id}  \\d+ B  \\d{4}-`));
  expect(await tool.run({ action: "show", id }, ctx)).toEqual([{ type: "text", text: `[image ${id}]` }, { type: "image", source: { type: "url", url: `orca-image:${id}` } }]);
  expect(await tool.run({ action: "show", id: "img-0000000000000000" }, ctx)).toBe("refused: no image img-0000000000000000 in this conversation");
  expect(await tool.run({ action: "show", id: "../x" }, ctx)).toBe("refused: no image ../x in this conversation");
});

test("the tab lists images with dimensions, counts them and opens one through the host", async () => {
  const { conversation, pctx } = await setup();
  const opened: string[] = [];
  expect(await ui.counts[0]!.count(pctx)).toBe(0);
  const id = await saveImage(conversation, png(4, 5));
  const tab = ui.tabs[0]!;
  const rows = await tab.rows(pctx);
  expect(rows.map(r => r.id)).toEqual([id]);
  expect(await ui.counts[0]!.count(pctx)).toBe(1);
  const details = await tab.details(rows[0]!, pctx);
  expect(details[0]!.lines[2]).toContain("4×5");
  const notes: string[] = [];
  const host = { ...pctx, note: (t: string) => { notes.push(t); }, open: async (file: string) => { opened.push(file); } } as unknown as UiHost;
  await tab.actions[0]!.run(rows[0]!, host);
  expect(opened).toEqual([details[0]!.lines[1]!]);
  expect(notes).toEqual([`opened ${id}`]);
});
