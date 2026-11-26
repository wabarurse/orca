
import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { ProviderName } from "./auth";
import type { RequestSettings } from "./model";
import type { SearchRequest, SearchResult } from "./search";

export type Turn = {
  usage?: { input: number; cachedInput?: number | undefined; cacheWriteInput?: number; output: number; reasoning?: number | undefined };
  content: ContentBlock[];
  stop: "end" | "tool_use" | "limit" | "pause" | "refusal" | "error";
  inputTokens?: number | undefined;
  completion?: string;
};

export type CompleteRequest = {
  trace?: { project?: string; agent?: string; run?: string; purpose?: string };
  cacheScope?: string;
  signal?: AbortSignal;
  settings?: RequestSettings | undefined;
  model: string;
  system?: string;
  messages: MessageParam[];
  tools: ApiTool[];
  maxTokens: number;
  onText: (delta: string) => void;
  onNotice?: (text: string) => void;
};

export type Provider = {
  name: ProviderName;
  account?: string;
  complete(req: CompleteRequest): Promise<Turn>;
  search?(req: SearchRequest): Promise<SearchResult>;
  models(): Promise<string[]>;
};
