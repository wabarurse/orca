import { imageBlock, imageFile } from "../../core/images";
import { definePlugin, type Plugin } from "../../core/plugins";
import { listImages, size, when } from "./store";

const plugin: Plugin = definePlugin({
  name: "images",
  description: "Images: agents list the conversation's images and show one by id; an Images tab opens them in the desktop viewer.",
  tools: [{
    roles: ["orchestrator", "worker", "reviewer"],
    replaces: false,
    tool: {
      parallel: () => true,
      spec: {
        name: "images",
        description: "The conversation's images (pasted by the user, read from files, returned by tools). list gives each id, size and time, newest first; show returns the image with that id so you can look at it again. Pass ids in the images field of subagent spawn or inbox to share one.",
        input_schema: {
          type: "object",
          properties: { action: { type: "string", enum: ["list", "show"] }, id: { type: "string", description: "show: an image id from list (img-…)." } },
          required: ["action"],
        },
      },
      async run(input, ctx) {
        if (input.action === "list") {
          const images = await listImages(ctx.conversation);
          if (!images.ok) return `refused: ${images.error}`;
          return images.data.length === 0 ? "no images" : images.data.map(i => `${i.id}  ${size(i.bytes)}  ${when(i.at)}`).join("\n");
        }
        if (input.action !== "show") return `refused: unknown action ${String(input.action)}`;
        const id = typeof input.id === "string" ? input.id.trim() : "";
        if (imageFile(ctx.conversation, id) === null) return `refused: no image ${id.length > 0 ? id : "(no id)"} in this conversation`;
        return [{ type: "text", text: `[image ${id}]` }, imageBlock(id)];
      },
    },
  }],
  prompt: [],
  skills: [],
  storage: [],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  bundles: [],
  guard: [],
  ui: "./ui.ts",
  background: null,
});

export default plugin;
