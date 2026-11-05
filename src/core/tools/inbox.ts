import { ask } from "./ask";
import { message } from "./message";
import type { Tool } from "./registry";

export const inbox: Tool = {
  spec: {
    name: "inbox",
    description:
      "Send a note or request a user decision. Use action=send with to and text for a note. " +
      "For an orchestrator question, use action=send, to=user, reply=required and text (with optional options/default), or questions to batch related questions. " +
      "Only the orchestrator can request user replies or use list/close for pending questions. Use list to check existing questions and close once answered in chat or obsolete. " +
      "Ask only for consequential unresolved decisions. Honor authorization already given in chat. Skipping a question is silent and never applies its default.\n" +
      "Batch related decisions and avoid duplicate questions. Continue authorized work on unaffected parts. " +
      message.spec.description,
    input_schema: {
      type: "object",
      properties: {
        ...(message.spec.input_schema.properties as Record<string, unknown>),
        ...(ask.spec.input_schema.properties as Record<string, unknown>),
        action: { type: "string", enum: ["send", "list", "close"] },
        reply: { type: "string", enum: ["optional", "required"], description: "Defaults to optional. Required opens a pending Questions Inbox entry and is valid only for to=user." },
        options: { type: "array", items: { type: "string" }, description: "Optional choices for a single required user question." },
        default: { type: "string", description: "Suggested answer for a single question. Never applied automatically." },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    if (input.action === "list" || input.action === "close") return ask.run(input, ctx);
    if (input.action !== "send") return "refused: inbox action must be send, list, or close";
    if (input.reply === "required") {
      if (input.attachments !== undefined || input.summary !== undefined) return "refused: questions accept text and choices only";
      if (input.to !== "user") return "refused: required replies are only supported for to=user";
      if (input.questions !== undefined && (input.text !== undefined || input.options !== undefined || input.default !== undefined)) {
        return "refused: use questions for a batch, or text with optional options/default for one question";
      }
      return ask.run({ action: "ask", questions: input.questions !== undefined ? input.questions : [{ text: input.text, options: input.options, default: input.default }] }, ctx);
    }
    if (input.reply !== undefined && input.reply !== "optional") return "refused: reply must be optional or required";
    if (input.questions !== undefined || input.options !== undefined || input.default !== undefined) return "refused: question fields require to=user and reply=required";
    return message.run(input, ctx);
  },
};
