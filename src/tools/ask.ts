import { cleanQuestions, ask as enqueue } from "../questions";
import type { Tool } from "./index";

// Orchestrator-only. Queues questions for the user and returns at once; the
// answers arrive later in the inbox from "user".
export const ask: Tool = {
  spec: {
    name: "ask",
    description:
      "Queue questions for the user. Returns their ids at once; answers arrive later in your inbox. " +
      "Batch related questions in one call, always give a default, and keep working on what you can meanwhile.",
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
              default: { type: "string", description: "What you will do if the user skips it. At most 100 chars." },
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
