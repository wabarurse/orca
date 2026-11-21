
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config";
import { activeProfile, type ProviderName } from "./auth";
import { claudeCredentials, readClaudeTokens } from "./auth";
import { codexCredentials, readCodexTokens } from "./auth";
import { anthropic, CLAUDE_BETAS } from "./anthropic";
import { openai } from "./openai";
import type { Provider } from "./provider";
import { metered, recordRetry } from "./usage";

export async function provider(name: ProviderName, options: { promptCache?: boolean; profile?: string } = {}): Promise<Provider> {
  const config = await loadConfig();
  const profile = activeProfile(options.profile ?? "");
  if (name === "anthropic") {
    if (process.env.ANTHROPIC_CUSTOM_HEADERS?.split("\n").some((line) => /^\s*authorization\s*:/i.test(line)) === true) {
      throw new Error("custom anthropic authorization headers are unsupported; use /login anthropic for claude code subscription access.");
    }
    if ((await readClaudeTokens(profile)) === null) throw new Error(`claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    return metered({ account: `${name}:${profile}`, ...anthropic(new Anthropic({
      apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: claudeCredentials(profile),
      defaultHeaders: { "anthropic-beta": CLAUDE_BETAS, "x-api-key": null },
      fetchOptions: { redirect: "error" },
    }), { promptCache: options.promptCache ?? (config.anthropicPromptCache === true), recovery: { enabled: true, account: `${name}:${profile}`, onRetry: event => recordRetry("anthropic", event) } }) });
  }
  if ((await readCodexTokens(profile)) === null) throw new Error(`codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
  return metered({ account: `${name}:${profile}`, ...openai(codexCredentials(profile), { recovery: { enabled: true, account: `${name}:${profile}`, onRetry: event => recordRetry("openai", event) } }) });
}
