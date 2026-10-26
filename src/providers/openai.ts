import { requireVision, validatedBase64 } from "./images";
import { boundedSearchResponse, SearchError, SEARCH_INSTRUCTIONS, searchPrompt } from "./search";
import { codexSearchItemSources, codexSearchResults } from "./search";
import { validateSettings, type RequestSettings } from "./catalog";
import OpenAI from "openai";
import type { FunctionTool, ResponseCompletedEvent, ResponseInputItem, ResponseOutputItem, ResponseOutputMessage, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import { CODEX_BASE_URL, type codexCredentials, type CodexTokens } from "../login";
import type { Provider, Turn } from "./provider";
import { rememberCatalogLimits } from "./catalog";
import { codexCatalogEfforts, rememberCatalogEfforts } from "./catalog";
import { exhaustedQuota, withTransientRetries, type RetryOptions } from "./retry";

// Protocol/catalog compatibility snapshot, matching Codex CLI 0.154.0.
export const CODEX_CLIENT_VERSION = "0.154.0";
type CodexInputItem = ResponseInputItem | Omit<ResponseOutputMessage, "id">;
type CodexStreamEvent = ResponseStreamEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" });

/** Preserve tool call IDs and encrypted Codex reasoning across stateless requests. */
export function toResponses(messages: MessageParam[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (const message of messages) {
    let user: { role: "user"; content: ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" })[] } | undefined;
    const addUser = (part: NonNullable<typeof user>["content"][number]) => {
      if (!user) { user = { role: "user", content: [] }; input.push(user); }
      user.content.push(part);
    };
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        if (message.role === "user") addUser({ type: "input_text", text: block.text });
        // Codex accepts stateless assistant history without a stored server item ID.
        else input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }], status: "completed" });
      } else if (block.type === "image") {
        if (message.role !== "user") throw new Error("assistant image input is unsupported.");
        const image = validatedBase64(block);
        addUser({ type: "input_image", image_url: `data:${image.mime};base64,${image.data}`, detail: "auto" });
      } else if (block.type === "tool_use") {
        user = undefined;
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === "tool_result") {
        user = undefined;
        if (Array.isArray(block.content) && block.content.some(b => b.type === "image")) throw new Error("nested tool images are unsupported; forward structured attachments instead.");
        const output = typeof block.content === "string" ? block.content
          : (block.content ?? []).map((part) => part.type === "text" ? part.text : "").join("\n");
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error ? `Error: ${output}` : output });
      } else if (block.type === "thinking") {
        user = undefined;
        try {
          const signature = JSON.parse(block.signature);
          if (signature.provider === "codex" && typeof signature.id === "string" && typeof signature.encrypted_content === "string") {
            input.push({ type: "reasoning", id: signature.id, summary: [], encrypted_content: signature.encrypted_content });
          }
        } catch { /* Claude thinking signatures do not belong in Codex requests. */ }
      }
    }
  }
  return input;
}

export function toResponseTools(tools: ApiTool[]): FunctionTool[] {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description,
    parameters: tool.input_schema as Record<string, unknown>, strict: false }));
}

export function fromResponses(output: ResponseOutputItem[]): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const item of output) {
    if ("status" in item && item.status && item.status !== "completed") throw new Error("codex returned an unfinished output item.");
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text, citations: null });
        else if (part.type === "refusal") content.push({ type: "text", text: part.refusal, citations: null });
      }
    } else if (item.type === "function_call") {
      let input: unknown;
      try { input = JSON.parse(item.arguments); } catch { throw new Error("codex returned invalid tool arguments."); }
      if (!input || typeof input !== "object" || Array.isArray(input) || !item.call_id || !item.name) throw new Error("codex returned an invalid tool call.");
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input, caller: { type: "direct" } });
    } else if (item.type === "reasoning" && item.encrypted_content) {
      content.push({ type: "thinking", thinking: item.summary.map((part) => part.text).join("\n"),
        signature: JSON.stringify({ provider: "codex", id: item.id, encrypted_content: item.encrypted_content }) });
    }
  }
  return content;
}

/** Keep refusal/unsupported output signals, allowing normal reasoning metadata. */
function summaryCompletion(output: ResponseOutputItem[]): string {
  if (output.some(item => item.type === "message" && item.content.some(part => part.type === "refusal"))) return "refusal";
  if (output.some(item => item.type !== "reasoning" && (item.type !== "message" || item.content.some(part => part.type !== "output_text")))) return "nontext";
  return "completed";
}

function clientFor(tokens: CodexTokens): OpenAI {
  return new OpenAI({
    // The SDK calls this option apiKey, but it sends our OAuth access token as Bearer auth.
    apiKey: tokens.accessToken, adminAPIKey: null, baseURL: CODEX_BASE_URL, organization: null, project: null,
    fetchOptions: { redirect: "error" },
    defaultHeaders: { authorization: `Bearer ${tokens.accessToken}`, "x-api-key": null, "api-key": null,
      "chatgpt-account-id": tokens.accountId, originator: "codex_cli_rs",
      "openai-beta": "responses=experimental", "user-agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} (orca)` },
  });
}

/** OpenAI models always use the Codex subscription endpoint. */
export function openai(credentials: ReturnType<typeof codexCredentials>, options: { retry?: Pick<RetryOptions, "backoffMs"> } = {}): Provider {
  const request = <T>(run: (client: OpenAI) => Promise<T>) => authorizedRequest(credentials, run);
  return {
    name: "openai",
    async complete(req) {
      requireVision(req.model, req.messages);
      const input = toResponses(req.messages) as ResponseInputItem[], settings = codexRequestSettings(req.model, req.settings);
      // Retries are ours (./retry), on the initial request only: the SDK's own are off.
      return withTransientRetries(async started => {
        const stream = await request((client) => client.responses.create({
          // The SDK's platform type requires server IDs that Codex's stateless history omits.
          model: req.model, input, instructions: req.system ? `You are Codex, an AI coding agent.\n\n${req.system}` : "You are Codex, an AI coding agent.",
          store: false, stream: true, parallel_tool_calls: true,
          ...settings, include: ["reasoning.encrypted_content"],
          ...(req.tools.length ? { tools: toResponseTools(req.tools), tool_choice: "auto" as const } : {}),
          // Codex manages its output budget; the backend rejects max_output_tokens.
        }, { signal: req.signal, maxRetries: 0 }));
        let usage: Turn["usage"];
        const output = await completedOutput(observed(stream as AsyncIterable<CodexStreamEvent>, started), req.onText, false, value => { usage = value; });
        const content = fromResponses(output);
        return { completion: summaryCompletion(output), content, ...(usage ? { usage, inputTokens: usage.input } : {}), stop: content.some((block) => block.type === "tool_use") ? "tool_use" : "end" };
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
      const output = await completedOutput(stream as AsyncIterable<CodexStreamEvent>, () => {}, true);
      req.signal.throwIfAborted();
      return codexSearchResults(output);
    },
    async models() {
      const catalog = await request((client) => client.get<{ models: { slug: string; visibility?: string; priority?: number; context_window?: unknown; supported_reasoning_levels?: unknown }[] }>("/models", {
        query: { client_version: CODEX_CLIENT_VERSION },
      }));
      if (!Array.isArray(catalog.models)) throw new Error("codex returned an invalid model catalog.");
      rememberCatalogLimits(catalog.models.filter((model) => typeof model?.slug === "string").map((model) => [model.slug, model.context_window]));
      rememberCatalogEfforts(catalog.models.filter((model) => typeof model?.slug === "string").map((model) => [model.slug, codexCatalogEfforts(model.supported_reasoning_levels)]));
      return catalog.models.filter((model) => typeof model.slug === "string" && model.visibility !== "hide")
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((model) => model.slug);
    },
  };
}

export function codexRequestSettings(model: string, settings: RequestSettings = {}) {
  validateSettings(model, settings);
  return {
    reasoning: { summary: "auto" as const, ...(settings.effort ? { effort: settings.effort } : {}) },
    ...(settings.fast ? { service_tier: "priority" as const } : {}),
  };
}

/** The stream with `started` called at its first event: from then on a failure is the stream's, not the request's. */
async function* observed<T>(stream: AsyncIterable<T>, started: () => void): AsyncIterable<T> {
  for await (const event of stream) { started(); yield event; }
}

const FAILED_EVENTS = new Set(["response.failed", "response.incomplete", "error"]);
async function completedOutput(stream: AsyncIterable<CodexStreamEvent>, onText: (text: string) => void, strict = false, onUsage?: (usage: NonNullable<Turn["usage"]>) => void): Promise<ResponseOutputItem[]> {
  const doneItems = new Map<number, ResponseOutputItem>();
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") onText(event.delta);
    else if (event.type === "response.output_item.done") {
      if (strict) {
        if (!Number.isInteger(event.output_index) || event.output_index < 0 || doneItems.has(event.output_index)) throw new SearchError("malformed");
        codexSearchItemSources(event.item);
      }
      doneItems.set(event.output_index, event.item);
    }
    else if (event.type === "response.completed" || event.type === "response.done") {
      const output = finalOutput(event, doneItems, strict);
      const usage = event.response.usage;
      if (usage) onUsage?.({ input: usage.input_tokens, cachedInput: usage.input_tokens_details?.cached_tokens,
        output: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens });
      return output;
    }
    else if (FAILED_EVENTS.has(event.type)) {
      if (!strict && exhaustedQuota(event)) throw event; // Keep structured stream evidence for the persistent error path.
      if (strict) throw new SearchError("incomplete");
      throw new Error("codex response failed or was incomplete; no tool calls were executed.");
    }
  }
  if (strict) throw new SearchError("incomplete");
  throw new Error("codex stream ended before the response completed.");
}
function finalOutput(event: ResponseCompletedEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" }), items: Map<number, ResponseOutputItem>, strict = false): ResponseOutputItem[] {
  if (strict) {
    if (!event.response || typeof event.response !== "object") throw new SearchError("malformed");
    if (event.response.status !== "completed") throw new SearchError("incomplete");
    const output = event.response.output;
    if (output != null && !Array.isArray(output)) throw new SearchError("malformed");
    if (output?.length) return output;
    // Live Codex sends complete items via output_item.done, then a completed
    // response with output: []. Empty is not an authoritative "no items" here.
    const entries = [...items].sort(([a], [b]) => a - b);
    if (entries.some(([index], position) => index !== position)) throw new SearchError("malformed");
    return entries.map(([, item]) => item);
  }
  if (event.response.status && event.response.status !== "completed") throw new Error("codex response did not complete successfully.");
  return event.response.output ?? [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
}

async function authorizedRequest<T>(credentials: ReturnType<typeof codexCredentials>, run: (client: OpenAI) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const tokens = await credentials();
  signal?.throwIfAborted();
  try { return await run(clientFor(tokens)); }
  catch (error) {
    if (!(error instanceof OpenAI.APIError) || error.status !== 401) throw error;
    // Retry only the initial HTTP request, never a partially consumed stream.
    signal?.throwIfAborted();
    const refreshed = await credentials({ forceRefresh: true });
    signal?.throwIfAborted();
    return run(clientFor(refreshed));
  }
}
