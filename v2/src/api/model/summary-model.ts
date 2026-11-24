import type { ProviderName } from "../auth";
import { effortRank, modelCapabilities, type Effort } from "./capabilities";
import { catalogLimitEntries } from "./context-window";
import { providerFor } from "./provider-for";

const SMALL: Record<ProviderName, string> = { anthropic: "claude-haiku-5-5", openai: "gpt-6-luna" };
const FAMILY: Record<ProviderName, string> = { anthropic: "haiku", openai: "luna" };

export function smallModel(provider: ProviderName): string {
  const listed = catalogLimitEntries().map(([model]) => model).filter(model => providerFor(model) === provider);
  if (listed.length === 0 || listed.includes(SMALL[provider])) return SMALL[provider];
  return listed.find(model => model.includes(FAMILY[provider])) ?? SMALL[provider];
}

export function effortUpTo(model: string, wanted: Effort): Effort | undefined {
  const offered = modelCapabilities(model).effort;
  return offered.filter(level => effortRank(level) <= effortRank(wanted)).at(-1) ?? offered[0];
}
