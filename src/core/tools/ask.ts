import { cleanQuestions, ask as enqueue, questions } from "../data/inbox";
import { limits, type Question } from "../../protocol";
import type { Tool } from "./registry";

// Orchestrator-only. Queues questions for the user and returns at once; the
// answers arrive later in the inbox from "user". `list` shows this project's
// pending questions; `close` withdraws ones answered in chat or made outdated:
// no reply message and no invented answer, and a user's answer always wins.

const MAX_LISTED = 50;

function listed(q: Question): string {
  const options = q.options?.length ? ` [options: ${q.options.join(" | ")}]` : "";
  const def = q.default ? ` [default: ${q.default}]` : "";
  return `- ${q.id} (asked ${q.ts}): ${q.text}${options}${def}`;
}

async function listPending(project: string): Promise<string> {
  const open = await questions.list(project);
  if (!open.length) return "no pending questions";
  const shown = open.slice(0, MAX_LISTED).map(listed);
  const more = open.length > MAX_LISTED ? `\n… ${open.length - MAX_LISTED} more (close some, then list again)` : "";
  return `${open.length} pending, oldest first:\n${shown.join("\n")}${more}`;
}

/** Why one id was not closed: an answer the user already gave is quoted, so it is never lost; otherwise the refusal. */
async function notClosed(project: string, id: string, err: unknown): Promise<string> {
  const q = (await questions.all(project).catch(() => [])).find(x => x.id === id);
  if (q?.status === "answered") return `not closed ${id}: the user already answered: ${q.answer ?? ""}`;
  return `not closed ${id}: ${err instanceof Error ? err.message : String(err)}`;
}

async function closePending(project: string, ids: unknown, rawReason: unknown): Promise<string> {
  const targets = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string" && !!x))] : [];
  if (!targets.length) return "refused: close needs ids from list";
  if (targets.length > limits.close) return `refused: over ${limits.close} ids in one close`;
  let reason: string;
  try {
    reason = questions.clean(typeof rawReason === "string" ? rawReason : "", limits.reason, "reason");
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
  if (!reason) return "refused: close needs a short reason";
  const lines: string[] = [];
  let closed = 0;
  for (const id of targets) {
    try {
      await questions.withdraw(project, id, reason);
      closed++;
      lines.push(`closed ${id}`);
    } catch (e) {
      lines.push(await notClosed(project, id, e));
    }
  }
  return `closed ${closed} of ${targets.length}:\n${lines.join("\n")}`;
}

export const ask: Tool = {
  spec: {
    name: "ask",
    description:
      "Queue necessary questions for the user (action ask, the default). Returns ids at once; answers arrive later in your inbox.\n" +
      "- Ask only for a currently unresolved decision or missing information needed now that materially affects scope/results, involves destructive/data-loss risk, or requires new access, credentials, provider or billing beyond existing authorization. Do not treat real scope expansion or destructive changes as routine.\n" +
      "- Do not ask about routine implementation details, local tests, debugging, review or bounded verification within an approved task, or repeatedly seek approval for its normal steps. For harmless reversible details, preserve established behavior or state a reasonable assumption.\n" +
      "- Before asking, use known project requirements, conversation and any known pending question IDs/content to avoid duplicating unanswered questions. Honor clear answers and authorization already given in chat; do not repeat approvals just because they were not clicked in Ctrl+Q.\n" +
      "- Chat replies do not close questions by themselves. action list shows this project's pending questions. When the user answers one in chat, or it becomes outdated, close it: action close with its ids and a short reason removes it from their Inbox, sends no reply and records no answer. If the user answered first, close says so and quotes the answer; their answer always wins.\n" +
      "- No speculative questions for paused/later work, status updates, or 'shall I continue?' when continuation is already authorized.\n" +
      "- Batch genuinely related necessary decisions in one call; keep questions/options concise, optionally include a suggested default, and keep working on unaffected parts.\n" +
      "- Skip silently removes a question from Inbox without sending you a reply or resuming work. A default is only a suggestion the user may explicitly answer with; Skip, silence and closing the panel never apply it. Never use a default, Skip or silence to authorize destructive steps or bypass explicit execution authorization for the shown branch plan.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["ask", "list", "close"], description: "ask (default) queues questions; list shows pending ones; close withdraws ids." },
        questions: {
          type: "array",
          description: "ask: at most 10.",
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
        ids: { type: "array", items: { type: "string" }, description: "close: pending question ids from list, at most 20." },
        reason: { type: "string", description: "close: why, e.g. answered in chat or outdated. At most 200 chars." },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    if (ctx.role !== "orchestrator") return "refused: only the orchestrator can ask";
    const action = input.action ?? "ask";
    try {
      if (action === "list") return await listPending(ctx.project);
      if (action === "close") return await closePending(ctx.project, input.ids, input.reason);
    } catch (e) {
      return `refused: ${(e as Error).message}`;
    }
    if (action !== "ask") return `refused: unknown action ${String(action)}`;
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
