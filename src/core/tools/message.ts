import { attachmentSchema, forwardImages } from "./attachments";
import { put } from "../data/inbox";
import { sessionId } from "../tmux";
import type { Tool } from "./registry";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";

// Claude Code's subagents isolate intermediate detail and return a summary:
// https://code.claude.com/docs/en/sub-agents . Orca enforces its own report bound
// at delivery; full evidence stays retrievable without another model call.
const REPORT_LIMIT = 2000;

// Every agent has an inbox. Addresses: "orchestrator", "user", or an agent id
// such as "worker-feat-login". Messages wait in the queue until the receiver
// next reads its inbox, so sending to a finished agent is fine.
export const message: Tool = {
  spec: {
    name: "message",
    description:
      "Send a message to another agent's inbox. `to` is \"orchestrator\", \"user\", or an agent id like " +
      "\"worker-feat-login\" (what spawn returned). Delivered when they next check their inbox. " +
      `Agent reports to orchestrator must fit ${REPORT_LIMIT} characters. If text is longer, supply summary; only summary plus an evidence path is delivered, and full text is archived. ` +
      "Preserve outcome, checked revision, checks, evidence references, failures, uncertainty and decisions needed. Send on completion, blockers or material changes; do not split logs across messages. A summary also archives shorter text.",
    input_schema: {
      type: "object",
      properties: {
        attachments: attachmentSchema,
        to: { type: "string" },
        text: { type: "string", description: "Message or full report. For agent reports over 2000 characters to orchestrator, include summary to keep full text out of its context." },
        summary: { type: "string", minLength: 1, maxLength: REPORT_LIMIT, description: "Required for agent reports over 2000 characters to orchestrator. Include outcome, checked revision, checks, evidence references, failures, uncertainty and decisions needed. Full text is saved separately." },
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
    const report = to === "orchestrator" && ctx.role !== "orchestrator";
    const archive = report && (text.length > REPORT_LIMIT || input.summary !== undefined);
    if (archive && (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > REPORT_LIMIT)) {
      throw new Error(`report not sent: supply a nonempty summary of at most ${REPORT_LIMIT} characters with outcome, checks, evidence references, failures, uncertainty and decisions needed; resend full text with summary to archive it`);
    }
    const attachments = await forwardImages(input.attachments, ctx);
    let delivered = text;
    if (archive) {
      const dir = join(paths.project(ctx.project), "tool-outputs", "reports");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${crypto.randomUUID()}.txt`);
      await writeFile(file, text, { mode: 0o600 });
      delivered = `${(input.summary as string).trim()}\nFull evidence: ${file}`;
    }
    await put(ctx.project, to, { from, text: delivered, ...(attachments.length ? { attachments } : {}) });
    return `sent to ${to}`;
  },
};
