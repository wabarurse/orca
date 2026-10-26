import { requireVision, validatedBase64 } from "./images";
import { boundedSearchResponse, SEARCH_INSTRUCTIONS, searchPrompt } from "./search";
import { claudeSearchResults } from "./search";
import { CLAUDE_BETAS } from "../login";
import { validateSettings, type RequestSettings } from "./catalog";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, ThinkingBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, Turn } from "./provider";
import { rememberCatalogLimits } from "./catalog";
import { claudeCatalogEfforts, rememberCatalogEfforts } from "./catalog";

// account.ts supplies Claude Code subscription credentials. There is no API-key mode.
export function anthropic(client: Anthropic, options: { promptCache?: boolean } = {}): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      requireVision(req.model, req.messages);
      const settings = claudeRequestSettings(req.model, req.settings);
      const stream = client.messages.stream({
        ...settings,
        model: req.model,
        max_tokens: req.maxTokens,
        // Cache the growing conversation prefix without changing transcript blocks.
        ...(options.promptCache ? { cache_control: { type: "ephemeral" as const } } : {}),
        messages: claudeMessages(req.messages),
        // The identity line is required by the Claude Code OAuth path; the role prompt follows it.
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          ...(req.system ? [{ type: "text" as const, text: req.system }] : []),
        ],
        ...(req.tools.length ? { tools: req.tools } : {}),
      }, { ...(req.signal ? { signal: req.signal } : {}), ...(req.settings?.fast && req.model !== "claude-opus-5-5"
        ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : {}) });
      stream.on("text", req.onText);
      const message = await stream.finalMessage();
      return completedTurn(message);
    },
    async search(req) {
      req.signal.throwIfAborted();
      const settings = claudeRequestSettings(req.model, req.settings);
      // Clone shares the configured subscription auth; no alternate model/client.
      const message = await client.withOptions({ maxRetries: 0, logLevel: "off" }).messages.create({
        ...settings, model: req.model, max_tokens: 2048,
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: SEARCH_INSTRUCTIONS },
        ],
        messages: [{ role: "user", content: searchPrompt(req) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      }, { signal: req.signal, maxRetries: 0,
        ...(req.settings?.fast && req.model !== "claude-opus-5-5"
          ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : {}),
        middleware: [async (request, next) => {
          req.signal.throwIfAborted();
          return boundedSearchResponse(await next(request), req.signal);
        }],
      });
      req.signal.throwIfAborted();
      return claudeSearchResults(message);
    },
    async models() {
      const all: { id: string; created_at: string; max_input_tokens?: number | null; capabilities?: unknown }[] = [];
      for await (const m of client.models.list()) all.push(m);
      rememberCatalogLimits(all.map((m) => [m.id, m.max_input_tokens]));
      rememberCatalogEfforts(all.map((m) => [m.id, claudeCatalogEfforts(m.capabilities)]));
      // Newest first, so callers can take the head as "recent".
      return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((m) => m.id);
    },
  };
}

function completedTurn(message: Message): Turn {
  const usage = message.usage;
  const inputTokens = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined;
  return { completion: message.stop_reason ?? "unknown", inputTokens,
    ...(usage ? { usage: { input: inputTokens!, cachedInput: usage.cache_read_input_tokens ?? 0,
      cacheWriteInput: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens } } : {}), content: message.content,
    stop: message.stop_reason === "tool_use" ? "tool_use" : "end" };
}

/** Only Codex reasoning is foreign. Claude signed/redacted thinking stays intact,
 * including cross-Claude-model requests: signature acceptance is server-defined. */
function foreignReasoning(block: ThinkingBlockParam): boolean {
  try { return JSON.parse(block.signature)?.provider === "codex"; }
  catch { return false; }
}
export function claudeMessages(messages: MessageParam[]): MessageParam[] {
  for (const message of messages) if (Array.isArray(message.content)) for (const block of message.content) {
    if (block.type === "image") {
      if (message.role !== "user") throw new Error("assistant image input is unsupported.");
      validatedBase64(block);
    }
    if (block.type === "tool_result" && Array.isArray(block.content) && block.content.some(b => b.type === "image")) throw new Error("nested tool images are unsupported; forward structured attachments instead.");
  }
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
