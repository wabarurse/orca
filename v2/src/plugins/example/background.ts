// The example plugin's daemon parts: pins kept verbatim beside rolling memory, and a watcher that keeps the list tidy.
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { readPins, writePins } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "dedupe", everyMs: 60_000,
    run: async ctx => {
      const dir = await ctx.data("conversation");
      const pins = await readPins(dir);
      const unique = pins.filter((p, i) => pins.findIndex(q => q.text === p.text) === i);
      if (unique.length < pins.length) await writePins(dir, unique);
    },
  }],
  memory: { title: "Pins", text: async ctx => (await readPins(await ctx.data("conversation"))).map(p => `- ${p.id}: ${p.text}`).join("\n") },
  runner: null,
  stop: null,
  remove: null,
});

export default background;
