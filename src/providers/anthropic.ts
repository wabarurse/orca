import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./index";

// Credentials come from the SDK's own chain: ANTHROPIC_API_KEY, or the OAuth
// profile that `ant auth login` stores under ~/.config/anthropic.
export function anthropic(client = new Anthropic()): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const stream = client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: req.messages,
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
