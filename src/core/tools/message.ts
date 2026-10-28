import { attachmentSchema, forwardImages } from "./attachments";
import { put } from "../data/inbox";
import { sessionId } from "../tmux";
import type { Tool } from "./registry";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";

// Every agent has an inbox. Addresses: "orchestrator", "user", or an agent id
// such as "worker-feat-login". Messages wait in the queue until the receiver
// next reads its inbox, so sending to a finished agent is fine.
export const message: Tool = {
  spec: {
    name: "message",
    description:
      "Send a message to another agent's inbox. `to` is \"orchestrator\", \"user\", or an agent id like " +
      "\"worker-feat-login\" (what spawn returned). Delivered when they next check their inbox. " +
      "Report outcomes, checked revision, checks, unresolved issues and evidence references. Full text is archived; if over 6000 characters supply a concise summary preserving failures and decisions. Details remain retrievable.",
    input_schema: {
      type: "object",
      properties: {
        attachments: attachmentSchema,
        to: { type: "string" },
        text: { type: "string" },
        summary: { type: "string", description: "Result under 4000 characters, including failures and pending decisions. Required for long reports to the orchestrator." },
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
    if (to === "user" && Array.isArray(input.attachments) && input.attachments.length) return "refused: image forwarding is agent-to-agent only";
    const attachments = await forwardImages(input.attachments, ctx);
    let delivered = text;
    if (to === "orchestrator" && ctx.role !== "orchestrator" && (text.length > 6000 || input.summary !== undefined)) {
      if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 4000) throw new Error("long report needs a summary under 4000 characters with outcomes, failures and decisions; full text will be saved");
      const dir = join(paths.project(ctx.project), "tool-outputs", "reports"); await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${crypto.randomUUID()}.txt`); await writeFile(file, text, { mode: 0o600 });
      delivered = `${input.summary}\nFull evidence: ${file}`;
    }
    await put(ctx.project, to, { from, text: delivered, ...(attachments.length ? { attachments } : {}) });
    return `sent to ${to}`;
  },
};
