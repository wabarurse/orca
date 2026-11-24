import { defineBackground, type PluginBackground } from "orca2/plugin";
import { readPins, shownPins, writePins } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "dedupe", everyMs: 60_000,
    run: async ctx => {
      const folder = await ctx.data("conversation");
      if (!folder.ok) return;
      const dir = folder.data;
      const read = await readPins(dir);
      if (!read.ok) return;
      const pins = read.data;
      const unique = pins.filter((p, i) => pins.findIndex(q => q.text === p.text) === i);
      if (unique.length < pins.length) await writePins(dir, unique);
    },
  }],
  memory: { title: "Pins", text: async ctx => (await shownPins(await ctx.data("conversation"))).map(p => `- ${p.id}: ${p.text}`).join("\n") },
  runner: null,
  stop: null,
  remove: null,
});

export default background;
