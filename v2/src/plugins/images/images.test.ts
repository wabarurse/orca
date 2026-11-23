import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { saveImage } from "../../core/images";
import { item, pluginContext, recordingHost, toolContext, unwrap } from "../../core/plugins/testing";
import { png } from "../../test/image-fixture";
import plugin from "./index";
import ui from "./ui";

const home = mkdtempSync(join(tmpdir(), "orca2-images-"));
const tool = item(plugin.tools, 0).tool;
const count = item(ui.counts, 0);

async function setup() {
  const conversation = await createConversation(home, "i");
  const ctx = toolContext(conversation.id, home, { agent: "worker-x", role: "worker", branch: "x" });
  return { conversation: conversation.id, ctx, pctx: pluginContext(conversation.id, "images", home) };
}

test("list and show go through the core image store; unknown ids are refused", async () => {
  const { conversation, ctx } = await setup();
  expect(await tool.run({ action: "list" }, ctx)).toBe("no images");
  const id = unwrap(await saveImage(conversation, png(3, 2)));
  expect(String(await tool.run({ action: "list" }, ctx))).toMatch(new RegExp(`^${id}  \\d+ B  \\d{4}-`));
  expect(await tool.run({ action: "show", id }, ctx)).toEqual([{ type: "text", text: `[image ${id}]` }, { type: "image", source: { type: "url", url: `orca-image:${id}` } }]);
  expect(await tool.run({ action: "show", id: "img-0000000000000000" }, ctx)).toBe("refused: no image img-0000000000000000 in this conversation");
  expect(await tool.run({ action: "show", id: "../x" }, ctx)).toBe("refused: no image ../x in this conversation");
});

test("the tab lists images with dimensions, counts them and opens one through the host", async () => {
  const { conversation, pctx } = await setup();
  expect(await count.count(pctx)).toBe(0);
  const id = unwrap(await saveImage(conversation, png(4, 5)));
  const tab = item(ui.tabs, 0);
  const rows = await tab.rows(pctx);
  expect(rows.map(r => r.id)).toEqual([id]);
  expect(await count.count(pctx)).toBe(1);
  const image = item(await tab.details(item(rows, 0), pctx), 0);
  expect(image.lines[2]).toContain("4×5");
  const { host, notes, opened } = recordingHost(pctx, { pick: null, input: null, confirm: true });
  await item(tab.actions, 0).run(item(rows, 0), host);
  expect(opened).toEqual([item(image.lines, 1)]);
  expect(notes).toEqual([`opened ${id}`]);
});

test("showing images folds them as + N images, each opening the Images tab", async () => {
  const { default: ui } = await import("./ui");
  const fold = ui.folds.images;
  expect(fold?.title(3)).toBe("3 images");
  expect(fold?.items({ action: "show", id: "img-1" }, { ok: true, text: "img-1" })).toEqual(["img-1"]);
  expect(fold?.items({ action: "show", id: "img-9" }, { ok: true, text: "refused: no image img-9 in this conversation" })).toEqual([]);
  expect(fold?.opens).toBe("images");
});
