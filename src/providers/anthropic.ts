import { CLAUDE_BETAS } from "../claude-auth";
import { validateSettings, type RequestSettings } from "../project-settings";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, ThinkingBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, Turn } from "./index";

// accounts.ts supplies Claude Code subscription credentials. There is no API-key mode.
export function anthropic(client: Anthropic): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const settings = claudeRequestSettings(req.model, req.settings);
      const stream = client.messages.stream({
        ...settings,
        model: req.model,
        max_tokens: req.maxTokens,
        messages: claudeMessages(req.messages),
        // The identity line is required by the Claude Code OAuth path; the role prompt follows it.
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          ...(req.system ? [{ type: "text" as const, text: req.system }] : []),
        ],
        ...(req.tools.length ? { tools: req.tools } : {}),
      }, req.settings?.fast && req.model !== "claude-opus-5-5"
        ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : undefined);
      stream.on("text", req.onText);
      const message = await stream.finalMessage();
      return completedTurn(message);
    },
    async models() {
      const all: { id: string; created_at: string }[] = [];
      for await (const m of client.models.list()) all.push(m);
      // Newest first, so callers can take the head as "recent".
      return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((m) => m.id);
    },
  };
}

function completedTurn(message: Message): Turn {
  const usage = message.usage;
  const inputTokens = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined;
  return { completion: message.stop_reason ?? "unknown", inputTokens, content: message.content,
    stop: message.stop_reason === "tool_use" ? "tool_use" : "end" };
}

/** Only Codex reasoning is foreign. Claude signed/redacted thinking stays intact,
 * including cross-Claude-model requests: signature acceptance is server-defined. */
function foreignReasoning(block: ThinkingBlockParam): boolean {
  try { return JSON.parse(block.signature)?.provider === "codex"; }
  catch { return false; }
}
export function claudeMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content
      : message.content.filter((block) => block.type !== "thinking" || !foreignReasoning(block)),
  })).filter((message) => message.content.length > 0);
}

export function claudeRequestSettings(model: string, settings: RequestSettings = {}) {
  validateSettings(model, settings);
  return {
    ...(settings.effort ? { output_config: { effort: settings.effort } } : {}),
    ...(settings.fast ? { speed: "fast" as const } : {}),
  };
}
