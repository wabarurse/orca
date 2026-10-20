import { put } from "../inbox";
import type { Tool } from "./index";

// Workers and reviewers write to the inbox for the orchestrator; the
// orchestrator writes to the outbox for whoever is connected.
export const message: Tool = {
  spec: {
    name: "message",
    description: "Send a message to the orchestrator (or, as orchestrator, to the user).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  async run(input, ctx) {
    const text = String(input.text ?? "").trim();
    if (!text) return "refused: empty message";
    const from = ctx.taskId ? `${ctx.role}-${ctx.taskId}` : ctx.role;
    const box = ctx.role === "orchestrator" ? "outbox" : "inbox";
    await put(ctx.project, { from, text }, box);
    return "sent";
  },
};
