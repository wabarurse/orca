import { join } from "node:path";
import { definePlugin, type Plugin } from "../../core/plugins";
import { addQuestions, cleanQuestions, closeQuestion, limits, openQuestions, type Question } from "./store";

const listed = (q: Question): string =>
  `- ${q.id}: ${q.text}${q.options.length > 0 ? ` [options: ${q.options.join(" | ")}]` : ""}${q.default !== null ? ` [suggested: ${q.default}]` : ""}`;

async function close(dir: string, ids: unknown, reason: unknown): Promise<string> {
  const targets = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
  if (targets.length === 0) return "refused: close needs ids from list";
  if (targets.length > limits.close) return `refused: at most ${limits.close} ids in one close`;
  if (typeof reason !== "string" || reason.trim().length === 0) return "refused: close needs a short reason";
  const lines: string[] = [];
  for (const id of targets) {
    const closed = await closeQuestion(dir, id, reason);
    lines.push(closed.ok ? `closed ${id}` : `not closed ${id}: ${closed.error}`);
  }
  return lines.join("\n");
}

const plugin: Plugin = definePlugin({
  name: "questions",
  description: "Questions: the orchestrator queues decisions for the user, answered or skipped on the Questions tab (Ctrl+Q).",
  tools: [{
    roles: ["orchestrator"],
    replaces: false,
    tool: {
      parallel: input => input.action === "list",
      spec: {
        name: "ask",
        description:
          "Queue questions for the user and keep working: returns ids at once, answers arrive later in your inbox as `[<id>] <answer>` from the user.\n" +
          "- Ask only consequential, unresolved decisions you cannot settle yourself (scope, destructive or irreversible steps, new access or cost). Not routine implementation details, and not approval for steps already authorized.\n" +
          "- Batch related questions (at most 4); options are short choices (2 to 6); a default is only a suggestion.\n" +
          "- Silence or skipping never applies the default and never grants approval: a skipped question sends you nothing.\n" +
          "- list shows open questions. When the user answers one in chat or it becomes outdated, close it with its ids and a short reason; if the user already answered, close says so and quotes the answer.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["ask", "list", "close"] },
            questions: {
              type: "array",
              description: "ask: 1 to 4 questions.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", description: "The question, at most 500 characters." },
                  options: { type: "array", items: { type: "string" }, description: "2 to 6 short choices, or none." },
                  default: { type: "string", description: "A suggested answer; never applied without the user choosing it." },
                },
                required: ["text"],
              },
            },
            ids: { type: "array", items: { type: "string" }, description: "close: open question ids from list." },
            reason: { type: "string", description: "close: why (answered in chat, outdated)." },
          },
          required: ["action"],
        },
      },
      async run(input, ctx) {
        if (ctx.role !== "orchestrator") return "refused: only the orchestrator asks the user";
        const dir = join(ctx.data, "questions");
        if (input.action === "list") {
          const open = await openQuestions(dir);
          if (!open.ok) return `refused: ${open.error}`;
          return open.data.length === 0 ? "no open questions" : `${open.data.length} open, oldest first:\n${open.data.map(listed).join("\n")}`;
        }
        if (input.action === "close") return close(dir, input.ids, input.reason);
        if (input.action !== "ask") return `refused: unknown action ${String(input.action)}`;
        const items = cleanQuestions(input.questions);
        if (!items.ok) return `refused: ${items.error}`;
        const asked = await addQuestions(dir, items.data);
        return `queued ${asked.length}: ${asked.map(q => q.id).join(", ")}`;
      },
    },
  }],
  prompt: [{ role: "orchestrator", text: "Put consequential unresolved decisions to the user with the ask tool and keep working; close questions the user answered in chat." }],
  skills: [],
  storage: [{ scope: "conversation", about: "questions/<id>.json: each question with its options, status and answer" }],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  bundles: [],
  guard: [],
  ui: "./ui.ts",
  background: null,
});

export default plugin;
