// Conservative protocol snapshot, not a claim of account entitlement. See
// docs/MODEL_SETTINGS.md for official sources and intentionally unsupported values.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const full: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const claudeFull = new Set([
  "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-4-7",
]);
const claudeFour = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);
const claudeFast = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
const codexFull = new Set([
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
  "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review",
]);
export function modelCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  if (claudeFull.has(model)) return { effort: [...full], fast: claudeFast.has(model) };
  if (claudeFour.has(model)) return { effort: full.filter((e) => e !== "xhigh"), fast: false };
  if (codexFull.has(model)) return { effort: [...full], fast: true };
  if (model === "gpt-5.5") return { effort: full.filter((e) => e !== "max"), fast: true };
  return { effort: [], fast: false };
}
