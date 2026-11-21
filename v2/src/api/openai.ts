import { diagnoseModelError, exhaustedQuota, providerRequest, type RecoveryPolicy, type RetryOptions } from "./errors";
import { createHash } from "node:crypto";
import { validatedBase64 } from "./images";
import { boundedSearchResponse, SearchError, SEARCH_INSTRUCTIONS, searchPrompt } from "./search";
import { codexSearchItemSources, codexSearchResults } from "./search";
import { validateSettings, type RequestSettings } from "./model";
import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import { z } from "zod";
import { fail, ok, type Result } from "./result";
import type { FunctionTool, ResponseCreateParamsStreaming, ResponseFunctionCallOutputItem, ResponseOutputItemDoneEvent, ResponseCompletedEvent, ResponseInputItem, ResponseOutputItem, ResponseOutputMessage, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { codexCredentials, CodexTokens } from "./auth";
import type { Provider, Turn } from "./provider";
import { rememberCatalogLimits } from "./model";
import { codexCatalogEfforts, rememberCatalogEfforts } from "./model";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const CODEX_CLIENT_VERSION = "0.154.0";
type CodexInputItem = ResponseInputItem | Omit<ResponseOutputMessage, "id">;
type CodexStreamEvent = ResponseStreamEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" });
type CodexRequestBody = Omit<ResponseCreateParamsStreaming, "input"> & { input: CodexInputItem[] };
const codexReasoning = z.object({ provider: z.literal("codex"), id: z.string(), encrypted_content: z.string() });
const catalogShape = z.object({ models: z.array(z.unknown()) });
const catalogModel = z.object({ slug: z.string(), visibility: z.unknown().optional(), priority: z.unknown().optional(), context_window: z.unknown().optional(), supported_reasoning_levels: z.unknown().optional() });
const cacheUsage = z.object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() });

function reasoningItem(signature: string): CodexInputItem | undefined {
  let json: unknown;
  try { json = JSON.parse(signature); }
  catch { return undefined; }
  const parsed = codexReasoning.safeParse(json);
  return parsed.success ? { type: "reasoning", id: parsed.data.id, summary: [], encrypted_content: parsed.data.encrypted_content } : undefined;
}

function imageURL(block: Parameters<typeof validatedBase64>[0]): string {
  const image = validatedBase64(block);
  if (!image.ok) throw new Error(image.error);
  return `data:${image.data.mime};base64,${image.data.data}`;
}

export function toResponses(messages: MessageParam[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (const message of messages) {
    let user: { role: "user"; content: ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" })[] } | undefined;
    const addUser = (part: NonNullable<typeof user>["content"][number]) => {
      if (user === undefined) { user = { role: "user", content: [] }; input.push(user); }
      user.content.push(part);
    };
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        if (message.role === "user") addUser({ type: "input_text", text: block.text });
        else if (block.text.trim() !== "") input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }], status: "completed" });
      } else if (block.type === "image") {
        if (message.role !== "user") throw new Error("assistant image input is unsupported.");
        addUser({ type: "input_image", image_url: imageURL(block), detail: "auto" });
      } else if (block.type === "tool_use") {
        user = undefined;
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === "tool_result") {
        user = undefined;
        const output = typeof block.content === "string" ? block.content
          : (block.content ?? []).map((part) => part.type === "text" ? part.text : "").join("\n");
        const parts = typeof block.content === "string" ? [] : block.content ?? [];
        if (!parts.some(part => part.type === "image")) {
          input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error === true ? `Error: ${output}` : output });
          continue;
        }
        const items = parts.flatMap((part): ResponseFunctionCallOutputItem[] => {
          if (part.type === "text") return [{ type: "input_text", text: part.text }];
          if (part.type !== "image") return [];
          return [{ type: "input_image", image_url: imageURL(part), detail: "auto" }];
        });
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error === true ? [{ type: "input_text", text: "Error:" }, ...items] : items });
      } else if (block.type === "thinking") {
        user = undefined;
        const reasoning = reasoningItem(block.signature);
        if (reasoning !== undefined) input.push(reasoning);
      }
    }
  }
  return input;
}

export function toResponseTools(tools: ApiTool[]): FunctionTool[] {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description,
    parameters: { ...tool.input_schema }, strict: false }));
}

export function fromResponses(output: ResponseOutputItem[]): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const item of output) {
    if ("status" in item && item.status !== undefined && item.status !== null && item.status !== "completed") throw new Error("codex returned an unfinished output item.");
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") { if (part.text !== "") content.push({ type: "text", text: part.text, citations: null }); }
        else if (part.type === "refusal") content.push({ type: "text", text: part.refusal, citations: null });
      }
    } else if (item.type === "function_call") {
      let input: unknown;
      try { input = JSON.parse(item.arguments); } catch { throw new Error("codex returned invalid tool arguments."); }
      if (input === null || typeof input !== "object" || Array.isArray(input) || item.call_id === "" || item.name === "") throw new Error("codex returned an invalid tool call.");
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input, caller: { type: "direct" } });
    } else if (item.type === "reasoning" && item.encrypted_content !== undefined && item.encrypted_content !== null && item.encrypted_content !== "") {
      content.push({ type: "thinking", thinking: item.summary.map((part) => part.text).join("\n"),
        signature: JSON.stringify({ provider: "codex", id: item.id, encrypted_content: item.encrypted_content }) });
    }
  }
  return content;
}

function summaryCompletion(output: ResponseOutputItem[]): string {
  if (output.some(item => item.type === "message" && item.content.some(part => part.type === "refusal"))) return "refusal";
  if (output.some(item => item.type !== "reasoning" && (item.type !== "message" || item.content.some(part => part.type !== "output_text")))) return "nontext";
  return "completed";
}

function clientFor(tokens: CodexTokens): OpenAI {
  return new OpenAI({
    apiKey: tokens.accessToken, adminAPIKey: null, baseURL: CODEX_BASE_URL, organization: null, project: null,
    fetchOptions: { redirect: "error" },
    defaultHeaders: { authorization: `Bearer ${tokens.accessToken}`, "x-api-key": null, "api-key": null,
      "chatgpt-account-id": tokens.accountId, originator: "codex_cli_rs",
      "openai-beta": "responses=experimental", "user-agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} (orca)` },
  });
}

export function openai(credentials: ReturnType<typeof codexCredentials>, options: { recovery?: RecoveryPolicy; retry?: Pick<RetryOptions, "backoffMs"> } = {}): Provider {
  const standaloneScope = crypto.randomUUID();
  const request = <T>(run: (client: OpenAI) => Promise<T>) => authorizedRequest(credentials, run);
  return {
    name: "openai",
    async complete(req) {
      const input = toResponses(req.messages), settings = codexRequestSettings(req.model, req.settings);
      const cacheKey = createHash("sha256").update(JSON.stringify([req.cacheScope ?? standaloneScope, req.model, req.system ?? "", req.tools])).digest("hex");
      const system = req.system;
      const body: CodexRequestBody = {
        model: req.model, input, instructions: system !== undefined && system !== "" ? `You are Codex, an AI coding agent.\n\n${system}` : "You are Codex, an AI coding agent.",
        store: false, stream: true, parallel_tool_calls: true,
        prompt_cache_key: cacheKey,
        ...settings, include: ["reasoning.encrypted_content"],
        ...(req.tools.length > 0 ? { tools: toResponseTools(req.tools), tool_choice: "auto" as const } : {}),
      };
      let refreshed = false;
      return providerRequest(options.recovery, async (started, scope) => {
        const signal = scope?.signal ?? req.signal;
        const allowRefresh = scope !== undefined ? () => { if (refreshed) return false; refreshed = true; return true; } : undefined;
        const stream = await authorizedRequest(credentials, (client) => {
          const active = scope !== undefined ? client.withOptions({ fetch: (url, init) => scope.fetch(url, { ...init, signal: scope.signal }), maxRetries: 0, logLevel: "off" }) : client;
          return active.post<Stream<ResponseStreamEvent>>("/responses", { body, stream: true, signal, maxRetries: 0, headers: { "session-id": cacheKey, "thread-id": cacheKey } });
        }, signal, allowRefresh);
        let usage: Turn["usage"];
        const completed = await completedOutput(observed(stream, started), req.onText, false, value => { usage = value; }, scope !== undefined);
        if (!completed.ok) throw completed.error;
        const output = completed.data;
        const content = fromResponses(output), completion = summaryCompletion(output);
        return { completion, content, ...(usage !== undefined ? { usage, inputTokens: usage.input } : {}), stop: completion === "refusal" ? "refusal" : content.some((block) => block.type === "tool_use") ? "tool_use" : completion === "nontext" ? "error" : "end" };
      }, { signal: req.signal, what: "codex", model: req.model, notice: req.onNotice, ...options.retry });
    },
    async search(req) {
      req.signal.throwIfAborted();
      const settings = codexRequestSettings(req.model, req.settings);
      const stream = await authorizedRequest(credentials, client => client.withOptions({
        maxRetries: 0, logLevel: "off",
        fetch: async (url, init) => {
          req.signal.throwIfAborted();
          return boundedSearchResponse(await fetch(url, init), req.signal);
        },
      }).responses.create({
        model: req.model, store: false, stream: true,
        instructions: `You are Codex, an AI coding agent.\n\n${SEARCH_INSTRUCTIONS}`,
        input: [{ role: "user", content: searchPrompt(req) }],
        ...settings, include: ["reasoning.encrypted_content"],
        tools: [{ type: "web_search", external_web_access: true, search_context_size: "low" }],
        tool_choice: "auto",
      }, { signal: req.signal, maxRetries: 0 }), req.signal);
      const output = await completedOutput(stream, () => {}, true);
      if (!output.ok) throw output.error;
      req.signal.throwIfAborted();
      const results = codexSearchResults(output.data);
      if (!results.ok) throw results.error;
      return results.data;
    },
    async models() {
      const response = await request((client) => client.get<unknown>("/models", {
        query: { client_version: CODEX_CLIENT_VERSION },
      }));
      const catalog = catalogShape.safeParse(response);
      if (!catalog.success) throw new Error("codex returned an invalid model catalog.");
      const models = catalog.data.models.flatMap(entry => {
        const parsed = catalogModel.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
      rememberCatalogLimits(models.map((model) => [model.slug, model.context_window]));
      rememberCatalogEfforts(models.map((model) => [model.slug, codexCatalogEfforts(model.supported_reasoning_levels)]));
      const priority = (value: unknown): number => typeof value === "number" ? value : 0;
      return models.filter((model) => model.visibility !== "hide")
        .sort((a, b) => priority(a.priority) - priority(b.priority)).map((model) => model.slug);
    },
  };
}

export function codexRequestSettings(model: string, settings: RequestSettings = {}) {
  const checked = validateSettings(model, settings);
  if (!checked.ok) throw new Error(checked.error);
  return {
    reasoning: { summary: "auto" as const, ...(settings.effort !== undefined ? { effort: settings.effort } : {}) },
    ...(settings.fast === true ? { service_tier: "priority" as const } : {}),
  };
}

async function* observed<T>(stream: AsyncIterable<T>, started: () => void): AsyncIterable<T> {
  for await (const event of stream) { started(); yield event; }
}

const FAILED_EVENTS = new Set(["response.failed", "response.incomplete", "error"]);
type Output = Result<ResponseOutputItem[], unknown>;
async function completedOutput(stream: AsyncIterable<CodexStreamEvent>, onText: (text: string) => void, strict = false, onUsage?: (usage: NonNullable<Turn["usage"]>) => void, drain = false): Promise<Output> {
  let completed: ResponseOutputItem[] | undefined;
  const doneItems = new Map<number, ResponseOutputItem>();
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") onText(event.delta);
    else if (event.type === "response.output_item.done") {
      const recorded = recordOutputItem(event, doneItems, strict);
      if (!recorded.ok) return recorded;
    }
    else if (event.type === "response.completed" || event.type === "response.done") {
      const output = completedEventOutput(event, doneItems, strict, onUsage);
      if (!drain || !output.ok) return output;
      completed = output.data;
    }
    else if (FAILED_EVENTS.has(event.type)) {
      if (!strict && drain) return fail(diagnoseModelError(event, true, "response"));
      if (!strict && exhaustedQuota(event) !== undefined) return fail(event);
      if (strict) return fail(new SearchError("incomplete"));
      return fail(new Error("codex response failed or was incomplete; no tool calls were executed."));
    }
  }
  if (completed !== undefined) return ok(completed);
  if (strict) return fail(new SearchError("incomplete"));
  return fail(new Error("codex stream ended before the response completed."));
}
function recordOutputItem(event: ResponseOutputItemDoneEvent, items: Map<number, ResponseOutputItem>, strict: boolean): Result<undefined, SearchError> {
  if (strict) {
    if (!Number.isInteger(event.output_index) || event.output_index < 0 || items.has(event.output_index)) return fail(new SearchError("malformed"));
    const sources = codexSearchItemSources(event.item);
    if (!sources.ok) return sources;
  }
  items.set(event.output_index, event.item);
  return ok(undefined);
}
function completedEventOutput(event: Parameters<typeof finalOutput>[0], items: Map<number, ResponseOutputItem>, strict: boolean, onUsage?: (usage: NonNullable<Turn["usage"]>) => void): Output {
  const output = finalOutput(event, items, strict);
  if (!output.ok) return output;
  const usage = event.response.usage;
  const parsed = cacheUsage.safeParse(usage?.input_tokens_details);
  const details = parsed.success ? parsed.data : undefined;
  const cacheWrite = details?.cache_write_tokens;
  if (usage !== undefined && usage !== null) onUsage?.({ input: usage.input_tokens, cachedInput: details?.cached_tokens,
    ...(cacheWrite !== undefined && Number.isSafeInteger(cacheWrite) && cacheWrite >= 0 ? { cacheWriteInput: cacheWrite } : {}),
    output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens });
  return output;
}
function doneSequence(items: Map<number, ResponseOutputItem>): ResponseOutputItem[] | undefined {
  const entries = [...items].sort(([a], [b]) => a - b);
  if (entries.some(([index], position) => index !== position)) return undefined;
  return entries.map(([, item]) => item);
}
function finalOutput(event: ResponseCompletedEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" }), items: Map<number, ResponseOutputItem>, strict = false): Output {
  if (strict) {
    const response: unknown = event.response;
    if (response === null || typeof response !== "object") return fail(new SearchError("malformed"));
    if (event.response.status !== "completed") return fail(new SearchError("incomplete"));
    const listed: unknown = event.response.output;
    if (listed !== null && listed !== undefined && !Array.isArray(listed)) return fail(new SearchError("malformed"));
    const output = event.response.output;
    if (output !== undefined && output !== null && output.length > 0) return ok(output);
    const sequence = doneSequence(items);
    return sequence !== undefined ? ok(sequence) : fail(new SearchError("malformed"));
  }
  if (event.response.status !== undefined && event.response.status !== null && event.response.status !== "completed") return fail(new Error("codex response did not complete successfully."));
  const output = event.response.output;
  if (output !== undefined && output !== null && output.length > 0) return ok(output);
  const sequence = doneSequence(items);
  return sequence !== undefined ? ok(sequence) : fail(new Error("codex returned an incomplete output item sequence; no tools executed."));
}

async function authorizedRequest<T>(credentials: ReturnType<typeof codexCredentials>, run: (client: OpenAI) => Promise<T>, signal?: AbortSignal, allowRefresh: () => boolean = () => true): Promise<T> {
  signal?.throwIfAborted();
  const tokens = await credentials();
  signal?.throwIfAborted();
  try { return await run(clientFor(tokens)); }
  catch (error) {
    if (!(error instanceof OpenAI.APIError) || error.status !== 401 || !allowRefresh()) throw error;
    signal?.throwIfAborted();
    const refreshed = await credentials({ forceRefresh: true });
    signal?.throwIfAborted();
    return run(clientFor(refreshed));
  }
}
