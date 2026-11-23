import { rm } from "node:fs/promises";
import type { Retention, SettledItem } from "../../core/plugins";
import { listImages } from "./store";

export const imageRetention: Retention = {
  tab: "images",
  archiveAfterDays: 1,
  purgeAfterDays: 14,
  settled: async (ctx): Promise<SettledItem[]> => {
    const images = await listImages(ctx.conversation);
    return images.ok ? images.data.map(image => ({ id: image.id, at: image.at })) : [];
  },
  locate: async (id, ctx) => {
    const images = await listImages(ctx.conversation);
    return images.ok ? images.data.find(image => image.id === id)?.file ?? null : null;
  },
  purge: async (ids, ctx) => {
    const images = await listImages(ctx.conversation);
    if (!images.ok) return;
    for (const image of images.data) if (ids.includes(image.id)) await rm(image.file, { force: true });
  },
};
