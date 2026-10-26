// The Provider for the active account of a provider name: Claude Code tokens
// behind the Anthropic SDK, or Codex tokens behind the OpenAI client.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config/config";
import { activeProfile, type ProviderName } from "../login/accounts";
import { CLAUDE_BETAS, claudeCredentials, readClaudeTokens } from "../login/claude";
import { codexCredentials, readCodexTokens } from "../login/codex";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import type { Provider } from "./provider";

export async function provider(name: ProviderName, options: { promptCache?: boolean } = {}): Promise<Provider> {
  const config = await loadConfig();
  const profile = activeProfile(name === "anthropic" ? config.account : config.openaiAccount);
  if (name === "anthropic") {
    // The SDK otherwise lets this legacy environment hook replace OAuth auth.
    if (process.env.ANTHROPIC_CUSTOM_HEADERS?.split("\n").some((line) => /^\s*authorization\s*:/i.test(line))) {
      throw new Error("custom anthropic authorization headers are unsupported; use /login anthropic for claude code subscription access.");
    }
    if (!(await readClaudeTokens(profile))) throw new Error(`claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    return anthropic(new Anthropic({
      apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: claudeCredentials(profile),
      defaultHeaders: { "anthropic-beta": CLAUDE_BETAS, "x-api-key": null },
      fetchOptions: { redirect: "error" },
    }), { promptCache: options.promptCache ?? (config.anthropicPromptCache === true) });
  }
  if (!(await readCodexTokens(profile))) throw new Error(`codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
  return openai(codexCredentials(profile));
}
