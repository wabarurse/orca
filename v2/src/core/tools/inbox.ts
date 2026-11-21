// The inbox tool: messages between agents and to the user. Messages only; questions are the questions plugin's.
import { put } from "../inbox";
import { imageFile } from "../images";
import type { Tool } from "./registry";

const ADDRESS = /^(orchestrator|user|[a-z][a-z0-9]*-[\w.-]+)$/;

export const inbox: Tool = {
  parallel: () => false,
  spec: { name: "inbox", description: "Send a message. to: \"orchestrator\" (a worker's report: outcome, changed files, checks, failures, decisions needed), \"user\" (shown in the user's chat; use it to show images by id), or an agent id such as worker-fix-login (queued for it; it reads the message after its current tool batch). A message never starts or resumes an agent: use subagent spawn for that. Keep reports within 2000 characters; put long evidence in the notebook and cite the page id.",
    input_schema: { type: "object", properties: {
      to: { type: "string" },
      text: { type: "string" },
      images: { type: "array", maxItems: 4, items: { type: "string" }, description: "Image ids of this conversation to send with the message." },
    }, required: ["to", "text"] } },
  async run(input, ctx) {
    const to = typeof input.to === "string" ? input.to.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";
    if (!ADDRESS.test(to)) throw new Error("to must be orchestrator, user or an agent id");
    if (to === ctx.agent) throw new Error("an agent cannot message itself");
    if (text.trim().length === 0) throw new Error("text must be non-empty");
    const images = Array.isArray(input.images) ? input.images.filter((id): id is string => typeof id === "string") : [];
    for (const id of images) if (imageFile(ctx.conversation, id) === null) throw new Error(`no image ${id} in this conversation`);
    await put(ctx.conversation, to, ctx.agent, text, { images, delivery: "steer" });
    return `sent to ${to}`;
  },
};
