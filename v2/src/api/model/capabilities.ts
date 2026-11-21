import { z } from "zod";

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
const codexLevel = z.object({ effort: z.unknown().optional() });
const supportedFlag = z.object({ supported: z.literal(true) });
const claudeCapability = z.object({ effort: z.record(z.string(), z.unknown()) });
const catalogEfforts = new Map<string, Effort[]>();
export function rememberCatalogEfforts(entries: Iterable<readonly [string, unknown]>): void {
  for (const [model, reported] of entries) {
    if (!Array.isArray(reported)) continue;
    const known = full.filter((level) => reported.includes(level));
    if (known.length > 0) catalogEfforts.set(model, known);
  }
}
export function clearCatalogEfforts(): void { catalogEfforts.clear(); }
export function codexCatalogEfforts(levelList: unknown): Effort[] {
  if (!Array.isArray(levelList)) return [];
  return levelList.flatMap((l) => {
    const parsed = codexLevel.safeParse(l);
    if (!parsed.success) return [];
    const level = parsed.data.effort;
    return full.filter(known => known === level);
  });
}
export function claudeCatalogEfforts(capability: unknown): Effort[] {
  const parsed = claudeCapability.safeParse(capability);
  if (!parsed.success) return [];
  const effort = parsed.data.effort;
  if (effort.supported !== true) return [];
  return full.filter((level) => supportedFlag.safeParse(effort[level]).success);
}
export function modelCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  const base = hardcodedCapabilities(model);
  const reported = catalogEfforts.get(model);
  return reported !== undefined ? { ...base, effort: [...reported] } : base;
}
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
