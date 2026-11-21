import type { ProviderName } from "../auth";
import { modelCapabilities, type Effort } from "./capabilities";

const SMALL: Record<ProviderName, string> = { anthropic: "claude-haiku-5-5", openai: "gpt-6-luna" };

export const smallModel = (provider: ProviderName): string => SMALL[provider];

export function effortUpTo(model: string, wanted: Effort): Effort | undefined {
  const order: Effort[] = ["low", "medium", "high", "xhigh", "max"], offered = modelCapabilities(model).effort;
  return offered.filter(level => order.indexOf(level) <= order.indexOf(wanted)).at(-1) ?? offered[0];
}
