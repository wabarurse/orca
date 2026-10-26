// A provider turns the transcript into one model turn. The transcript stays
// Anthropic-shaped (text / tool_use / tool_result blocks) whatever the
// provider; OpenAI is translated on the way in and out.

import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { ProviderName } from "../login/accounts";
import type { RequestSettings } from "./catalog/settings";
import type { SearchRequest, SearchResult } from "./search/web-search";

export interface Turn {
  usage?: { input: number; cachedInput?: number; cacheWriteInput?: number; output: number; reasoning?: number };
  /** Assistant content, Anthropic-shaped. */
  content: ContentBlock[];
  /** Whether the model wants tools run before it continues. */
  stop: "end" | "tool_use";
  inputTokens?: number;
  /** Terminal provider reason; absent only for legacy/custom providers. */
  completion?: string;
}

export interface CompleteRequest {
  signal?: AbortSignal;
  settings?: RequestSettings;
  model: string;
  /** The role's system prompt; providers put their own identity line first. */
  system?: string;
  messages: MessageParam[];
  tools: ApiTool[];
  maxTokens: number;
  onText: (delta: string) => void;
}

export interface Provider {
  name: ProviderName;
  complete(req: CompleteRequest): Promise<Turn>;
  /** Isolated native search on this same subscription connection. No history is sent. */
  search?(req: SearchRequest): Promise<SearchResult>;
  /** Model ids this account can use, most useful first. */
  models(): Promise<string[]>;
}

/** Which provider serves a model id. Claude models go to Anthropic; anything else to OpenAI. */
export function providerFor(model: string): ProviderName {
  return model.startsWith("claude") ? "anthropic" : "openai";
}
