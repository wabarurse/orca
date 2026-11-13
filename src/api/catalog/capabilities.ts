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
const levels = new Set<string>(full);
/** Effort levels reported by provider model catalogs, in memory per process. Empty or
 * unrecognized lists are ignored so the hardcoded table below remains the fallback. */
const catalogEfforts = new Map<string, Effort[]>();
export function rememberCatalogEfforts(entries: Iterable<readonly [string, unknown]>): void {
  for (const [model, reported] of entries) {
    if (!Array.isArray(reported)) continue;
    const known = full.filter((level) => reported.includes(level));
    if (known.length) catalogEfforts.set(model, known);
  }
}
export function clearCatalogEfforts(): void { catalogEfforts.clear(); }
/** Codex catalog `supported_reasoning_levels`: [{ effort }, …]. */
export function codexCatalogEfforts(levelList: unknown): Effort[] {
  if (!Array.isArray(levelList)) return [];
  return levelList.map((l) => (l as { effort?: unknown } | null)?.effort).filter((e): e is Effort => typeof e === "string" && levels.has(e));
}
/** Anthropic models API `capabilities.effort`: one `{ supported }` flag per level. */
export function claudeCatalogEfforts(capability: unknown): Effort[] {
  const effort = (capability as { effort?: Record<string, { supported?: unknown } | null> & { supported?: unknown } } | null | undefined)?.effort;
  if (!effort || effort.supported !== true) return [];
  return full.filter((level) => effort[level]?.supported === true);
}
/** The current list: catalog-reported levels when known in this process, else the built-in table.
 * Time-varying (the catalog lands in the background) and per process, so request paths must not throw on it. */
export function modelCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  const base = hardcodedCapabilities(model);
  const reported = catalogEfforts.get(model);
  return reported ? { ...base, effort: [...reported] } : base;
}
/** Every level either source has reported for the model: what a request may still carry
 * when the catalog lands between settings resolution and the provider's own check. */
export function knownEfforts(model: string): Effort[] {
  const table = hardcodedCapabilities(model).effort;
  const reported = catalogEfforts.get(model) ?? [];
  return full.filter((level) => table.includes(level) || reported.includes(level));
}
function hardcodedCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  if (claudeFull.has(model)) return { effort: [...full], fast: claudeFast.has(model) };
  if (claudeFour.has(model)) return { effort: full.filter((e) => e !== "xhigh"), fast: false };
  if (codexFull.has(model)) return { effort: [...full], fast: true };
  if (model === "gpt-5.5") return { effort: full.filter((e) => e !== "max"), fast: true };
  return { effort: [], fast: false };
}
