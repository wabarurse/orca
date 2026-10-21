import { ask as enqueue, type NewQuestion } from "../questions";
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
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              options: { type: "array", items: { type: "string" }, description: "Short choices." },
              default: { type: "string", description: "What you will do if the user skips it." },
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
    const raw = Array.isArray(input.questions) ? input.questions : [];
    const items: NewQuestion[] = [];
    for (const r of raw) {
      const q = (r ?? {}) as Record<string, unknown>;
      const text = typeof q.text === "string" ? q.text.trim() : "";
      if (!text) return "refused: every question needs text";
      const options = Array.isArray(q.options) ? q.options.map(String).map((o) => o.trim()).filter(Boolean) : undefined;
      const def = typeof q.default === "string" ? q.default.trim() : undefined;
      items.push({ text, options, default: def });
    }
    if (!items.length) return "refused: no questions";
    const qs = await enqueue(ctx.project, items);
    return `queued ${qs.length}: ${qs.map((q) => q.id).join(", ")}`;
  },
};
