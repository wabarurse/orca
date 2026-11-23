import { errorMessage } from "../../config";
import { defineUi, type PluginUi } from "../../core/plugins";
import { settled } from "../../core/tools/registry";
import { dimensions, listImages, size, when, type StoredImage } from "./store";

const shown = async (conversation: string): Promise<StoredImage[]> => settled(await listImages(conversation));

const ui: PluginUi = defineUi({
    tabs: [{
      id: "images",
      title: "Images",
      chord: null,
      rows: async ctx => (await shown(ctx.conversation)).map(i => ({ id: i.id, name: i.id, status: size(i.bytes), info: when(i.at), tone: "normal" })),
      details: async (row, ctx) => {
        const image = (await shown(ctx.conversation)).find(i => i.id === row.id);
        if (image === undefined) return [];
        const dims = await dimensions(image.file);
        return [{ title: "Image", lines: [image.id, image.file, `${size(image.bytes)}${dims === null ? "" : ` · ${dims.width}×${dims.height}`} · ${image.at}`] }];
      },
      actions: [{
        key: "o", label: "open",
        run: async (row, host) => {
          if (row === null) return;
          const images = await listImages(host.conversation);
          const image = images.ok ? images.data.find(i => i.id === row.id) : undefined;
          if (image === undefined) { host.note(`${row.id} is gone`); return; }
          await host.open(image.file).then(() => { host.note(`opened ${image.id}`); }, (error: unknown) => { host.note(`could not open ${image.id}: ${errorMessage(error)}`); });
        },
      }],
    }],
    counts: [{ id: "images", count: async ctx => {
      const images = await listImages(ctx.conversation);
      return images.ok ? images.data.length : null;
    }, label: n => `${n} image${n === 1 ? "" : "s"}` }],
    commands: [],
    toolLines: {
      images: {
        label: input => input.action === "show" ? `images(show ${String(input.id)})` : `images(${String(input.action)})`,
        summary: o => ({ summary: o.text.split("\n")[0] ?? "", failed: !o.ok || o.text.startsWith("refused") }),
      },
    },
    folds: {
      images: {
        title: n => `${n} image${n === 1 ? "" : "s"}`,
        items: (input, o) => input.action === "show" && o.ok && !o.text.startsWith("refused") && typeof input.id === "string" ? [input.id] : [],
        opens: "images",
      },
    },
});

export default ui;
