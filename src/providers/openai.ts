import { validateSettings, type RequestSettings } from "../project-settings";
import OpenAI from "openai";
import type { FunctionTool, ResponseCompletedEvent, ResponseInputItem, ResponseOutputItem, ResponseOutputMessage, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import { CODEX_BASE_URL, type codexCredentials, type CodexTokens } from "../codex-auth";
import type { Provider } from "./index";

// Protocol/catalog compatibility snapshot, matching Codex CLI 0.154.0.
export const CODEX_CLIENT_VERSION = "0.154.0";
type CodexInputItem = ResponseInputItem | Omit<ResponseOutputMessage, "id">;
type CodexStreamEvent = ResponseStreamEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" });

/** Preserve tool call IDs and encrypted Codex reasoning across stateless requests. */
export function toResponses(messages: MessageParam[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        input.push(message.role === "user"
          ? { role: "user", content: [{ type: "input_text", text: block.text }] }
          // Codex accepts stateless assistant history without a stored server item ID.
          : { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }], status: "completed" });
      } else if (block.type === "tool_use") {
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === "tool_result") {
        const output = typeof block.content === "string" ? block.content
          : (block.content ?? []).map((part) => part.type === "text" ? part.text : "").join("\n");
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error ? `Error: ${output}` : output });
      } else if (block.type === "thinking") {
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
    if ("status" in item && item.status && item.status !== "completed") throw new Error("Codex returned an unfinished output item.");
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text, citations: null });
        else if (part.type === "refusal") content.push({ type: "text", text: part.refusal, citations: null });
      }
    } else if (item.type === "function_call") {
      let input: unknown;
      try { input = JSON.parse(item.arguments); } catch { throw new Error("Codex returned invalid tool arguments."); }
      if (!input || typeof input !== "object" || Array.isArray(input) || !item.call_id || !item.name) throw new Error("Codex returned an invalid tool call.");
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
      "openai-beta": "responses=experimental", "user-agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} (parallels)` },
  });
}

/** OpenAI models always use the Codex subscription endpoint. */
export function openai(credentials: ReturnType<typeof codexCredentials>): Provider {
  const request = <T>(run: (client: OpenAI) => Promise<T>) => authorizedRequest(credentials, run);
  return {
    name: "openai",
    async complete(req) {
      const stream = await request((client) => client.responses.create({
        // The SDK's platform type requires server IDs that Codex's stateless history omits.
        model: req.model, input: toResponses(req.messages) as ResponseInputItem[], instructions: req.system ? `You are Codex, an AI coding agent.\n\n${req.system}` : "You are Codex, an AI coding agent.",
        store: false, stream: true, parallel_tool_calls: true,
        ...codexRequestSettings(req.model, req.settings), include: ["reasoning.encrypted_content"],
        ...(req.tools.length ? { tools: toResponseTools(req.tools), tool_choice: "auto" as const } : {}),
        // Codex manages its output budget; the backend rejects max_output_tokens.
      }, { signal: req.signal }));
      const output = await completedOutput(stream as AsyncIterable<CodexStreamEvent>, req.onText);
      const content = fromResponses(output);
      return { completion: summaryCompletion(output), content, stop: content.some((block) => block.type === "tool_use") ? "tool_use" : "end" };
    },
    async models() {
      const catalog = await request((client) => client.get<{ models: { slug: string; visibility?: string; priority?: number }[] }>("/models", {
        query: { client_version: CODEX_CLIENT_VERSION },
      }));
      if (!Array.isArray(catalog.models)) throw new Error("Codex returned an invalid model catalog.");
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

const FAILED_EVENTS = new Set(["response.failed", "response.incomplete", "error"]);
async function completedOutput(stream: AsyncIterable<CodexStreamEvent>, onText: (text: string) => void): Promise<ResponseOutputItem[]> {
  const doneItems = new Map<number, ResponseOutputItem>();
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") onText(event.delta);
    else if (event.type === "response.output_item.done") doneItems.set(event.output_index, event.item);
    else if (event.type === "response.completed" || event.type === "response.done") return finalOutput(event, doneItems);
    else if (FAILED_EVENTS.has(event.type)) throw new Error("Codex response failed or was incomplete; no tool calls were executed.");
  }
  throw new Error("Codex stream ended before the response completed.");
}
function finalOutput(event: ResponseCompletedEvent | (Omit<ResponseCompletedEvent, "type"> & { type: "response.done" }), items: Map<number, ResponseOutputItem>): ResponseOutputItem[] {
  if (event.response.status && event.response.status !== "completed") throw new Error("Codex response did not complete successfully.");
  return event.response.output ?? [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
}

async function authorizedRequest<T>(credentials: ReturnType<typeof codexCredentials>, run: (client: OpenAI) => Promise<T>): Promise<T> {
  const tokens = await credentials();
  try { return await run(clientFor(tokens)); }
  catch (error) {
    if (!(error instanceof OpenAI.APIError) || error.status !== 401) throw error;
    // Retry only the initial HTTP request, never a partially consumed stream.
    return run(clientFor(await credentials({ forceRefresh: true })));
  }
}
