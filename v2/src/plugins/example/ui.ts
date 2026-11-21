import { defineUi, type PluginUi } from "../../core/plugins";
import { readPins, shownPins, writePins } from "./store";

const ui: PluginUi = defineUi({
  tabs: [{
    id: "pins",
    title: "Pins",
    chord: null,
    rows: async ctx => (await shownPins(await ctx.data("conversation"))).map(p => ({ id: p.id, name: p.text, status: p.by, info: p.at.slice(0, 16), tone: "normal" })),
    details: async (row, ctx) => {
      const pin = (await shownPins(await ctx.data("conversation"))).find(p => p.id === row.id);
      return pin === undefined ? [] : [{ title: "Pin", lines: [pin.text, `by ${pin.by} at ${pin.at}`] }];
    },
    actions: [{
      key: "d", label: "unpin",
      run: async (row, host) => {
        if (row === null || !await host.confirm(`unpin ${row.id}?`)) return;
        const dir = await host.data("conversation");
        const read = await readPins(dir);
        if (!read.ok) { host.note(read.error); return; }
        await writePins(dir, read.data.filter(p => p.id !== row.id));
        host.note(`unpinned ${row.id}`);
      },
    }],
  }],
  counts: [{ id: "pins", count: async ctx => (await shownPins(await ctx.data("conversation"))).length, label: n => `${n} pin${n === 1 ? "" : "s"}` }],
  commands: [{
    name: "pin", description: "pin a note: /pin <text>",
    run: async (args, host) => {
      const text = args.trim().length > 0 ? args.trim() : await host.input("pin", "");
      if (text === null || text.length === 0) return;
      const dir = await host.data("conversation");
      const read = await readPins(dir);
      if (!read.ok) { host.note(read.error); return; }
      const pins = read.data;
      await writePins(dir, [...pins, { id: `p${pins.length + 1}`, text, by: "user", at: new Date().toISOString() }]);
      host.note("pinned");
    },
  }],
  toolLines: { pin: { label: input => `pin(${String(input.action)}${typeof input.text === "string" ? `: ${input.text.slice(0, 40)}` : ""})`, summary: outcome => ({ summary: outcome.text.split("\n")[0] ?? "", failed: !outcome.ok || outcome.text.startsWith("refused") }) } },
  folds: { pin: { title: n => `${n} pin${n === 1 ? "" : "s"}`, items: (input, outcome) => input.action === "add" && outcome.ok && typeof input.text === "string" ? [input.text] : [], opens: "pins" } },
});

export default ui;
