import { cleanQuestions, ask as enqueue } from "../data/inbox/questions";
import type { Tool } from "./index";

// Orchestrator-only. Queues questions for the user and returns at once; the
// answers arrive later in the inbox from "user".
export const ask: Tool = {
  spec: {
    name: "ask",
    description:
      "Queue necessary questions for the user. Returns ids at once; answers arrive later in your inbox.\n" +
      "- Ask only for a currently unresolved decision or missing information needed now that materially affects scope/results, involves destructive/data-loss risk, or requires new access, credentials, provider or billing beyond existing authorization. Do not treat real scope expansion or destructive changes as routine.\n" +
      "- Do not ask about routine implementation details, local tests, debugging, review or bounded verification within an approved task, or repeatedly seek approval for its normal steps. For harmless reversible details, preserve established behavior or state a reasonable assumption.\n" +
      "- Before asking, use known project requirements, conversation and any known pending question IDs/content to avoid duplicating unanswered questions. Honor clear answers and authorization already given in chat; do not repeat approvals just because they were not clicked in Ctrl+Q. This tool cannot list or close pending questions; chat replies do not close them.\n" +
      "- No speculative questions for paused/later work, status updates, or 'shall I continue?' when continuation is already authorized.\n" +
      "- Batch genuinely related necessary decisions in one call; keep questions/options concise, optionally include a suggested default, and keep working on unaffected parts.\n" +
      "- Skip silently removes a question from Inbox without sending you a reply or resuming work. A default is only a suggestion the user may explicitly answer with; Skip, silence and closing the panel never apply it. Never use a default, Skip or silence to authorize destructive steps or bypass explicit execution authorization for the shown branch plan.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "At most 10.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "At most 500 chars." },
              options: { type: "array", items: { type: "string" }, description: "Short choices, at most 8." },
              default: { type: "string", description: "Optional suggested answer; never applied by Skip, silence or closing the panel, and never permission for destructive steps or an unapproved plan. At most 100 chars." },
            },
            required: ["text"],
          },
        },
      },
      required: ["questions"],
    },
  },
  async run(input, ctx) {
    if (ctx.role !== "orchestrator") return "refused: only the orchestrator can ask";
    let items;
    try {
      items = cleanQuestions(input.questions);
    } catch (e) {
      return `refused: ${(e as Error).message}`;
    }
    const qs = await enqueue(ctx.project, items);
    return `queued ${qs.length}: ${qs.map((q) => q.id).join(", ")}`;
  },
};
