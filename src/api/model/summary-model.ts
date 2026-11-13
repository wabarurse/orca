import type { ProviderName } from "../auth";
import { modelCapabilities, type Effort } from "./capabilities";

const SMALL: Record<ProviderName, string> = { anthropic: "claude-haiku-5-5", openai: "gpt-6-luna" };

/** A provider's small model: what the orchestrator's background memory is summarized with. */
export const smallModel = (provider: ProviderName): string => SMALL[provider];

/** The level a model offers that is nearest `wanted` without exceeding it, else its lowest; undefined when it has none known. */
export function effortUpTo(model: string, wanted: Effort): Effort | undefined {
  const order: Effort[] = ["low", "medium", "high", "xhigh", "max"], offered = modelCapabilities(model).effort;
  return offered.filter(level => order.indexOf(level) <= order.indexOf(wanted)).at(-1) ?? offered[0];
}
