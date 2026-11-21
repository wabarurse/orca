import type { ProviderName } from "../auth";

/** Which provider serves a model id. Claude models go to Anthropic; anything else to OpenAI. */
export function providerFor(model: string): ProviderName {
  return model.startsWith("claude") ? "anthropic" : "openai";
}
