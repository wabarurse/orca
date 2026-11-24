import { z } from "zod";
import { exhaustedQuota, providerRequest, type RecoveryPolicy, type RequestScope, type RetryOptions } from "./errors";
import { validatedBase64 } from "./images";
import { boundedSearchResponse, SEARCH_INSTRUCTIONS, searchPrompt } from "./search";
import { claudeSearchResults } from "./search";
import { validateSettings, type RequestSettings } from "./model";
import Anthropic, { type Middleware, type MiddlewareNext } from "@anthropic-ai/sdk";
import type { Message, MessageParam, MessageCreateParamsBase, OutputConfig, TextBlockParam, ThinkingBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, Turn } from "./provider";
import { rememberCatalogLimits } from "./model";
import { claudeCatalogEfforts, rememberCatalogEfforts } from "./model";

export const CLAUDE_BETAS = "claude-code-20250219,oauth-2025-04-20";

function textBlock(text: string, cache: Pick<TextBlockParam, "cache_control">): TextBlockParam {
  return { type: "text", text, ...cache };
}

export function anthropic(client: Anthropic, options: { recovery?: RecoveryPolicy; promptCache?: boolean; retry?: Pick<RetryOptions, "backoffMs"> } = {}): Provider {
  return {
    name: "anthropic",
    async complete(req) {
      const settings = claudeRequestSettings(req.model, req.settings);
      const cache: Pick<TextBlockParam, "cache_control"> = options.promptCache === true ? { cache_control: { type: "ephemeral" } } : {};
      const params: MessageCreateParamsBase = {
        ...settings,
        model: req.model,
        max_tokens: req.maxTokens,
        ...cache,
        messages: claudeMessages(req.messages),
        system: [
          textBlock("You are Claude Code, Anthropic's official CLI for Claude.", {}),
          ...(req.system !== undefined && req.system !== "" ? [textBlock(req.system, cache)] : []),
        ],
        ...(req.tools.length > 0 ? { tools: req.tools } : {}),
      };
      const recovery = completionRecovery();
      return providerRequest(options.recovery, async (started, scope) => {
        const active = scope !== undefined ? client.withOptions({ maxRetries: 0, logLevel: "off" }) : client;
        const complete = async () => {
          const stream = active.messages.stream(params, { maxRetries: 0,
            middleware: [recovery.middleware(scope)], signal: scope?.signal ?? req.signal,
            ...(req.settings?.fast === true && req.model !== "claude-opus-5-5" ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : {}) });
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
      const message = await client.withOptions({ maxRetries: 0, logLevel: "off" }).messages.create({
        ...settings, model: req.model, max_tokens: 2048,
        system: [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: SEARCH_INSTRUCTIONS },
        ],
        messages: [{ role: "user", content: searchPrompt(req) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      }, { signal: req.signal, maxRetries: 0,
        ...(req.settings?.fast === true && req.model !== "claude-opus-5-5"
          ? { headers: { "anthropic-beta": `${CLAUDE_BETAS},fast-mode-2026-02-01` } } : {}),
        middleware: [async (request, next) => {
          req.signal.throwIfAborted();
          return boundedSearchResponse(await next(request), req.signal);
        }],
      });
      req.signal.throwIfAborted();
      const results = claudeSearchResults(message);
      if (!results.ok) throw results.error;
      return results.data;
    },
    async models() {
      const all: { id: string; created_at: string; max_input_tokens?: number | null; capabilities?: unknown }[] = [];
      for await (const m of client.models.list()) all.push(m);
      rememberCatalogLimits(all.map((m) => [m.id, m.max_input_tokens]));
      rememberCatalogEfforts(all.map((m) => [m.id, claudeCatalogEfforts(m.capabilities)]));
      return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((m) => m.id);
    },
  };
}

function completionRecovery() {
  let refreshed = false;
  let send: RequestScope["fetch"] = () => Promise.reject(new Error("anthropic request was sent before its middleware ran"));
  const fetch: RequestScope["fetch"] = (input, init) => send(input, init);
  return {
    fetch,
    middleware(scope?: RequestScope): Middleware {
      return async (request, next, context) => {
        send = (_, init) => {
          const forwarded: Parameters<MiddlewareNext>[0] = { ...request, ...init, url: request.url, headers: init?.headers === undefined ? request.headers : new Headers(init.headers) };
          return next(forwarded);
        };
        const response = scope !== undefined ? await scope.fetch(request.url, { ...request, signal: scope.signal }) : await next(request);
        const parsed: unknown = response.ok ? undefined : await context.parse(response).catch(() => undefined);
        if (!response.ok && exhaustedQuota(parsed) !== undefined) {
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
        if (scope === undefined || refreshed || !(error instanceof Anthropic.APIError) || error.status !== 401) throw error;
        scope.signal.throwIfAborted();
        refreshed = true;
        return complete();
      }
    },
  };
}

const messageUsage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullable().optional(),
  cache_creation_input_tokens: z.number().nullable().optional(),
});

function completedTurn(message: Message): Turn {
  const parsed = messageUsage.safeParse(message.usage);
  const usage = parsed.success ? parsed.data : undefined;
  const inputTokens = usage === undefined ? undefined : usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { completion: message.stop_reason ?? "unknown", inputTokens,
    ...(usage !== undefined && inputTokens !== undefined ? { usage: { input: inputTokens, cachedInput: usage.cache_read_input_tokens ?? 0,
      cacheWriteInput: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens } } : {}), content: message.content,
    stop: message.stop_reason === "tool_use" ? "tool_use" : message.stop_reason === "max_tokens" ? "limit"
      : message.stop_reason === "pause_turn" ? "pause" : message.stop_reason === "refusal" ? "refusal"
      : message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence" ? "end" : "error" };
}

const codexSignature = z.object({ provider: z.literal("codex") });
function foreignReasoning(block: ThinkingBlockParam): boolean {
  let signature: unknown;
  try { signature = JSON.parse(block.signature); }
  catch { return false; }
  return codexSignature.safeParse(signature).success;
}
const blankText = (block: MessageParam["content"][number]) => typeof block !== "string" && block.type === "text" && block.text.trim() === "";
const reasoningOnly = (message: MessageParam) => message.role === "assistant" && typeof message.content !== "string"
  && message.content.every(block => block.type === "thinking" || block.type === "redacted_thinking");
export function claudeMessages(messages: MessageParam[]): MessageParam[] {
  const problem = imageProblem(messages);
  if (problem !== undefined) throw new Error(problem);
  const kept = messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? message.content
      : message.content.filter((block) => !blankText(block) && (block.type !== "thinking" || !foreignReasoning(block))),
  })).filter((message) => message.content.length > 0);
  for (let last = kept.at(-1); last !== undefined && reasoningOnly(last); last = kept.at(-1)) kept.pop();
  return kept;
}

function imageProblem(messages: MessageParam[]): string | undefined {
  for (const message of messages) if (Array.isArray(message.content)) for (const block of message.content) {
    const images = block.type === "image" ? [block]
      : block.type === "tool_result" && Array.isArray(block.content) ? block.content.flatMap(item => item.type === "image" ? [item] : []) : [];
    for (const image of images) {
      if (message.role !== "user") return "assistant image input is unsupported.";
      const checked = validatedBase64(image);
      if (!checked.ok) return checked.error;
    }
  }
  return undefined;
}

const wireEffort = z.custom<NonNullable<OutputConfig["effort"]>>(value => typeof value === "string" && value.length > 0);

export function claudeRequestSettings(model: string, settings: RequestSettings = {}): Pick<MessageCreateParamsBase, "output_config" | "speed"> {
  const checked = validateSettings(model, settings);
  if (!checked.ok) throw new Error(checked.error);
  return {
    ...(settings.effort !== undefined ? { output_config: { effort: wireEffort.parse(settings.effort) } } : {}),
    ...(settings.fast === true ? { speed: "fast" } : {}),
  };
}
