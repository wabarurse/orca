import type { RequestScope } from "./bounded-transport";
import { providerRequest, type RecoveryPolicy } from "./provider-recovery";
import { validatedBase64 } from "./images";
import { boundedSearchResponse, SEARCH_INSTRUCTIONS, searchPrompt } from "./search";
import { claudeSearchResults } from "./search";
import { CLAUDE_BETAS } from "../login";
import { validateSettings, type RequestSettings } from "./catalog";
import Anthropic, { type Middleware, type MiddlewareNext } from "@anthropic-ai/sdk";
import type { Message, MessageParam, ThinkingBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, Turn } from "./provider";
import { rememberCatalogLimits } from "./catalog";
import { claudeCatalogEfforts, rememberCatalogEfforts } from "./catalog";
import { exhaustedQuota, type RetryOptions } from "./retry";

// account.ts supplies Claude Code subscription credentials. There is no API-key mode.
export function anthropic(client: Anthropic, options: { recovery?: RecoveryPolicy; promptCache?: boolean; retry?: Pick<RetryOptions, "backoffMs"> } = {}): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const settings = claudeRequestSettings(req.model, req.settings);
      const params = {
        ...settings,
        model: req.model,
        max_tokens: req.maxTokens,
        // Cache the growing conversation prefix without changing transcript blocks.
        ...(options.promptCache ? { cache_control: { type: "ephemeral" as const } } : {}),
        messages: claudeMessages(req.messages),
        // The identity line is required by the Claude Code OAuth path; the role prompt follows it.
        system: [
          { type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." },
          ...(req.system ? [{ type: "text" as const, text: req.system }] : []),
        ],
        ...(req.tools.length ? { tools: req.tools } : {}),
      };
      const recovery = completionRecovery();
      return providerRequest(options.recovery, async (started, scope) => {
        const active = scope ? client.withOptions({ maxRetries: 0, logLevel: "off" }) : client;
        const complete = async () => {
          const stream = active.messages.stream(params, { maxRetries: 0,
            middleware: [recovery.middleware(scope)], signal: scope?.signal ?? req.signal,
            ...(req.settings?.fast && req.model !== "claude-opus-5-5" ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : {}) });
          stream.on("streamEvent", started);
          stream.on("text", req.onText);
          const message = await stream.finalMessage();
          return completedTurn(message);
        };
        return recovery.authorize(complete, scope);
      }, { signal: req.signal, what: "claude", model: req.model, notice: req.onNotice, ...options.retry }, recovery.fetch);
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

/** One closure per completion, never per transient attempt: refresh budget is shared. */
function completionRecovery() {
  let refreshed = false;
  let send: RequestScope["fetch"];
  return {
    fetch: ((input, init) => send(input, init)) as RequestScope["fetch"],
    middleware(scope?: RequestScope): Middleware {
      return async (request, next, context) => {
        // Preserve the configured transport and request fields without private SDK access.
        send = (_, init) => next({ ...request, ...init } as Parameters<MiddlewareNext>[0]);
        // SDK iterator cleanup aborts its private signal on success/error. Caller abort
        // is already linked to the helper lifetime, which owns transport cancellation.
        const response = scope ? await scope.fetch(request.url, { ...request, signal: scope.signal }) : await next(request);
        if (!response.ok && exhaustedQuota(await context.parse(response).catch(() => undefined))) {
          const headers = new Headers(response.headers);
          headers.set("x-should-retry", "false");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        return response;
      };
    },
    async authorize<T>(complete: () => Promise<T>, scope?: RequestScope): Promise<T> {
      try { return await complete(); }
      catch (error) {
        if (!scope || refreshed || !(error instanceof Anthropic.APIError) || error.status !== 401) throw error;
        // With zero SDK retries, its 401 handler still invalidates the credential
        // cache. Dispatch once more within this scope to obtain refreshed credentials.
        scope.signal.throwIfAborted();
        refreshed = true;
        return complete();
      }
    },
  };
}

function completedTurn(message: Message): Turn {
  const usage = message.usage;
  const inputTokens = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined;
  return { completion: message.stop_reason ?? "unknown", inputTokens,
    ...(usage ? { usage: { input: inputTokens!, cachedInput: usage.cache_read_input_tokens ?? 0,
      cacheWriteInput: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens } } : {}), content: message.content,
    stop: message.stop_reason === "tool_use" ? "tool_use" : message.stop_reason === "max_tokens" ? "limit"
      : message.stop_reason === "pause_turn" ? "pause" : message.stop_reason === "refusal" ? "refusal"
      : message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence" ? "end" : "error" };
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
    // A tool's image result (`read` of an image) goes inside its tool_result, as the Messages API admits.
    if (block.type === "tool_result" && Array.isArray(block.content)) for (const item of block.content) if (item.type === "image") {
      if (message.role !== "user") throw new Error("assistant image input is unsupported.");
      validatedBase64(item);
    }
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
