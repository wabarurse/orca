// The Images tab: the conversation's images newest first; `o` opens the selected one in the desktop viewer.
import { defineUi, type PluginUi } from "../../core/plugins";
import { dimensions, listImages, size, when } from "./store";

const ui: PluginUi = defineUi({
    tabs: [{
      id: "images",
      title: "Images",
      chord: null,
      rows: async ctx => (await listImages(ctx.conversation)).map(i => ({ id: i.id, name: i.id, status: size(i.bytes), info: when(i.at), tone: "normal" })),
      details: async (row, ctx) => {
        const image = (await listImages(ctx.conversation)).find(i => i.id === row.id);
        if (image === undefined) return [];
        const dims = await dimensions(image.file);
        return [{ title: "Image", lines: [image.id, image.file, `${size(image.bytes)}${dims === null ? "" : ` · ${dims.width}×${dims.height}`} · ${image.at}`] }];
      },
      actions: [{
        key: "o", label: "open",
        run: async (row, host) => {
          if (row === null) return;
          const image = (await listImages(host.conversation)).find(i => i.id === row.id);
          if (image === undefined) { host.note(`${row.id} is gone`); return; }
          try { await host.open(image.file); host.note(`opened ${image.id}`); }
          catch (e) { host.note(`could not open ${image.id}: ${e instanceof Error ? e.message : String(e)}`); }
        },
      }],
    }],
    counts: [{ id: "images", count: async ctx => (await listImages(ctx.conversation)).length, label: n => `${n} image${n === 1 ? "" : "s"}` }],
    commands: [],
    toolLines: {
      images: {
        label: input => input.action === "show" ? `images(show ${String(input.id)})` : `images(${String(input.action)})`,
        summary: o => ({ summary: o.text.split("\n")[0] ?? "", failed: !o.ok || o.text.startsWith("refused") }),
      },
    },
    folds: {},
});

export default ui;
