import { put } from "../inbox";
import { sessionId } from "../runner";
import type { Tool } from "./index";

// Every agent has an inbox. Addresses: "orchestrator", "user", or an agent id
// such as "worker-feat-login". Messages wait in the queue until the receiver
// next reads its inbox, so sending to a finished agent is fine.
export const message: Tool = {
  spec: {
    name: "message",
    description:
      "Send a message to another agent's inbox. `to` is \"orchestrator\", \"user\", or an agent id like " +
      "\"worker-feat-login\" (what spawn returned). Delivered when they next check their inbox. " +
      "Messages to \"orchestrator\" should be complete, not summarized: it acts only on what you send.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        text: { type: "string" },
      },
      required: ["to", "text"],
    },
  },
  async run(input, ctx) {
    const to = String(input.to ?? "").trim();
    const text = String(input.text ?? "").trim();
    if (!to) return "refused: `to` is required";
    if (!text) return "refused: empty message";
    const from = sessionId(ctx.role, ctx.branch);
    if (to === from) return "refused: that's your own inbox";
    await put(ctx.project, to, { from, text });
    return `sent to ${to}`;
  },
};
