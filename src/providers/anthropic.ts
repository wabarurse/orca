import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./index";

// accounts.ts supplies Claude Code subscription credentials. There is no API-key mode.
export function anthropic(client: Anthropic): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const stream = client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: req.messages,
        // Required by the Claude Code OAuth path; not persisted in the transcript.
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        ...(req.tools.length ? { tools: req.tools } : {}),
      });
      stream.on("text", req.onText);
      const message = await stream.finalMessage();
      return { content: message.content, stop: message.stop_reason === "tool_use" ? "tool_use" : "end" };
    },
    async models() {
      const all: { id: string; created_at: string }[] = [];
      for await (const m of client.models.list()) all.push(m);
      // Newest first, so callers can take the head as "recent".
      return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((m) => m.id);
    },
  };
}
