import type { RequestSettings } from "../project-settings";
// A provider turns the transcript into one model turn. The transcript stays
// Anthropic-shaped (text / tool_use / tool_result blocks) whatever the
// provider; OpenAI is translated on the way in and out.

import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";

export type ProviderName = "anthropic" | "openai";

export interface Turn {
  /** Assistant content, Anthropic-shaped. */
  content: ContentBlock[];
  /** Whether the model wants tools run before it continues. */
  stop: "end" | "tool_use";
}

export interface CompleteRequest {
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
  /** Model ids this account can use, most useful first. */
  models(): Promise<string[]>;
}

/** Which provider serves a model id. Claude models go to Anthropic; anything else to OpenAI. */
export function providerFor(model: string): ProviderName {
  return model.startsWith("claude") ? "anthropic" : "openai";
}
