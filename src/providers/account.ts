// The Provider for a provider name and profile (the project's selected account): Claude Code tokens
// behind the Anthropic SDK, or Codex tokens behind the OpenAI client.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config";
import { activeProfile, type ProviderName } from "../login";
import { CLAUDE_BETAS, claudeCredentials, readClaudeTokens } from "../login";
import { codexCredentials, readCodexTokens } from "../login";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import type { Provider } from "./provider";
import { metered, recordRetry } from "./usage";

/** `options.profile` is the asking project's selected profile (see core/data/projects/project-account.ts); there is no global active account. */
export async function provider(name: ProviderName, options: { promptCache?: boolean; profile?: string } = {}): Promise<Provider> {
  const config = await loadConfig();
  const profile = activeProfile(options.profile ?? "");
  if (name === "anthropic") {
    // The SDK otherwise lets this legacy environment hook replace OAuth auth.
    if (process.env.ANTHROPIC_CUSTOM_HEADERS?.split("\n").some((line) => /^\s*authorization\s*:/i.test(line))) {
      throw new Error("custom anthropic authorization headers are unsupported; use /login anthropic for claude code subscription access.");
    }
    if (!(await readClaudeTokens(profile))) throw new Error(`claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    return metered({ account: `${name}:${profile}`, ...anthropic(new Anthropic({
      apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: claudeCredentials(profile),
      defaultHeaders: { "anthropic-beta": CLAUDE_BETAS, "x-api-key": null },
      fetchOptions: { redirect: "error" },
    }), { promptCache: options.promptCache ?? (config.anthropicPromptCache === true), recovery: { enabled: true, account: `${name}:${profile}`, onRetry: event => recordRetry("anthropic", event) } }) });
  }
  if (!(await readCodexTokens(profile))) throw new Error(`codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
  return metered({ account: `${name}:${profile}`, ...openai(codexCredentials(profile), { recovery: { enabled: true, account: `${name}:${profile}`, onRetry: event => recordRetry("openai", event) } }) });
}
