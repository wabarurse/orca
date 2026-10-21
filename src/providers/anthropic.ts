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
        // Codex encrypted reasoning is not a Claude thinking signature. Keep
        // the shared transcript untouched; omit only foreign reasoning here.
        messages: req.messages.map((message) => ({
          ...message,
          content: typeof message.content === "string" ? message.content : message.content.filter((block) => {
            if (block.type !== "thinking") return true;
            try { return JSON.parse(block.signature).provider !== "codex"; }
            catch { return true; }
          }),
        })).filter((message) => message.content.length > 0),
        // The identity line is required by the Claude Code OAuth path; the role prompt follows it.
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          ...(req.system ? [{ type: "text" as const, text: req.system }] : []),
        ],
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
