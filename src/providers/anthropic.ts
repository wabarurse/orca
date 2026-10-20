import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./index";

// accounts.ts supplies explicit API-key or Claude subscription credentials.
export function anthropic(client: Anthropic, options: { subscription?: boolean } = {}): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const stream = client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: req.messages,
        // Required by the Claude Code OAuth compatibility path; not persisted
        // in the transcript or sent for API-key requests.
        ...(options.subscription ? { system: [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }] } : {}),
        ...(req.tools.length ? { tools: req.tools } : {}),
      });
      stream.on("text", req.onText);
      const message = await stream.finalMessage();
      return { content: message.content, stop: message.stop_reason === "tool_use" ? "tool_use" : "end" };
    },
    async models() {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    },
  };
}
