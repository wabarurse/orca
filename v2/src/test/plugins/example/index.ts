import { join } from "node:path";
import { z, defineEvent, definePlugin, defineService, type Links, type Plugin } from "orca2/plugin";
import { readPins, shownPins, writePins } from "./store";

const MAX = 200;

async function addPin(dir: string, text: string, by: string, links: Links): Promise<string> {
  const read = await readPins(dir);
  const pins = read.ok ? read.data : [];
  const pin = { id: `p${pins.length + 1}`, text, by, at: new Date().toISOString() };
  await writePins(dir, [...pins, pin]);
  await links.emit("pinned", { id: pin.id, text });
  return pin.id;
}

const plugin: Plugin = definePlugin({
  name: "example",
  description: "Pins: short notes agents keep for the conversation (a worked example of every plugin slot).",
  tools: [{
    roles: ["orchestrator", "worker", "reviewer"],
    replaces: false,
    tool: {
      parallel: input => input.action === "list",
      spec: { name: "pin", description: "Pin a short note for this conversation (a decision, a link, a reminder), list pins, or unpin one by id. Pins survive compaction.",
        input_schema: { type: "object", properties: { action: { type: "string", enum: ["add", "list", "remove"] }, text: { type: "string" }, id: { type: "string" } }, required: ["action"] } },
      async run(input, ctx) {
        const dir = join(ctx.data, "example");
        const read = await readPins(dir);
        if (!read.ok) return `refused: ${read.error}`;
        const pins = read.data;
        if (input.action === "list") return pins.length === 0 ? "no pins" : pins.map(p => `${p.id}: ${p.text}`).join("\n");
        if (input.action === "remove") {
          const left = pins.filter(p => p.id !== input.id);
          if (left.length === pins.length) return `refused: no pin ${String(input.id)}`;
          await writePins(dir, left);
          return `unpinned ${String(input.id)}`;
        }
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (text.length === 0) return "refused: a pin needs text";
        return `pinned ${await addPin(dir, text, ctx.agent, ctx.links)}`;
      },
    },
  }],
  prompt: [{ role: "orchestrator", text: "Pin decisions and links the user will want to find again with the pin tool." }],
  skills: ["skills/pins"],
  storage: [{ scope: "conversation", about: "example/pins.json: the pinned notes" }],
  hooks: {
    beforeTool: [async (call) => {
      if (call.name === "pin" && typeof call.input.text === "string" && call.input.text.length > MAX) return { action: "block", reason: `a pin is at most ${MAX} characters` };
      return { action: "run", input: call.input };
    }],
    afterTool: [],
    beforeRequest: [],
    onInput: [],
  },
  guard: [{
    id: "pins-file", group: "efficiency",
    test: call => call.command !== null && ["cat", "head", "tail"].includes(call.command.program) && call.command.args.some(arg => arg.endsWith("example/pins.json")),
    reason: "pins are kept by the pin tool",
    suggest: () => "pin with action list",
  }],
  bundles: [],
  retention: [{
    tab: "pins",
    archiveAfterDays: null,
    purgeAfterDays: 30,
    settled: async () => [],
    locate: async () => null,
    purge: async (ids, ctx) => {
      const folder = await ctx.data("conversation");
      if (!folder.ok) return;
      await writePins(folder.data, (await shownPins(folder)).filter(p => !ids.includes(p.id)));
    },
  }],
  provides: [defineService("add", "pin a note for this conversation; returns { id }", z.object({ text: z.string().min(1).max(MAX) }), async (input, ctx) => {
    const folder = await ctx.data("conversation");
    if (!folder.ok) return folder;
    return { ok: true, data: { id: await addPin(folder.data, input.text, ctx.from, ctx.links) } };
  })],
  uses: [],
  emits: [defineEvent("pinned", "a pin was added: { id, text }", z.object({ id: z.string(), text: z.string() }))],
  on: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
