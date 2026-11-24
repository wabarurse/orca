import { z } from "zod";

export type Effort = string;
const ORDER: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const full: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const claudeFull = new Set([
  "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-4-7",
]);
const claudeFour = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);
const claudeFast = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
const codexFull = new Set([
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
  "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review",
]);
const LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;
const codexLevel = z.object({ effort: z.string() });
const supportedFlag = z.object({ supported: z.literal(true) });
const claudeCapability = z.object({ effort: z.record(z.string(), z.unknown()) });
const tierList = z.array(z.unknown());
const catalogEfforts = new Map<string, Effort[]>();
const catalogFast = new Map<string, boolean>();

export function effortRank(level: Effort): number {
  const known = ORDER.indexOf(level);
  return known >= 0 ? known : ORDER.length;
}

function ordered(levels: Iterable<Effort>): Effort[] {
  return [...new Set(levels)].filter(level => LEVEL.test(level)).sort((a, b) => effortRank(a) - effortRank(b));
}

export function rememberCatalogEfforts(entries: Iterable<readonly [string, unknown]>): void {
  for (const [model, reported] of entries) {
    if (!Array.isArray(reported)) continue;
    const levels = ordered(reported.filter((level): level is string => typeof level === "string"));
    if (levels.length > 0) catalogEfforts.set(model, levels);
  }
}

export function rememberCatalogFast(entries: Iterable<readonly [string, boolean | null]>): void {
  for (const [model, fast] of entries) if (fast !== null) catalogFast.set(model, fast);
}

export function clearCatalogEfforts(): void {
  catalogEfforts.clear();
  catalogFast.clear();
}

export function codexCatalogEfforts(levelList: unknown): Effort[] {
  if (!Array.isArray(levelList)) return [];
  return ordered(levelList.flatMap(level => {
    const parsed = codexLevel.safeParse(level);
    return parsed.success ? [parsed.data.effort] : [];
  }));
}

export function codexCatalogFast(serviceTiers: unknown, speedTiers: unknown): boolean | null {
  const tiers = tierList.safeParse(serviceTiers), speeds = tierList.safeParse(speedTiers);
  if (!tiers.success && !speeds.success) return null;
  return (tiers.success ? tiers.data.length : 0) + (speeds.success ? speeds.data.length : 0) > 0;
}

export function claudeCatalogEfforts(capability: unknown): Effort[] {
  const parsed = claudeCapability.safeParse(capability);
  if (!parsed.success) return [];
  const effort = parsed.data.effort;
  if (!supportedFlag.safeParse(effort).success) return [];
  return ordered(Object.keys(effort).filter(level => level !== "supported" && supportedFlag.safeParse(effort[level]).success));
}

export function modelCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  const table = hardcodedCapabilities(model);
  return { effort: [...(catalogEfforts.get(model) ?? table.effort)], fast: catalogFast.get(model) ?? table.fast };
}

export function knownEfforts(model: string): Effort[] {
  return ordered([...hardcodedCapabilities(model).effort, ...(catalogEfforts.get(model) ?? [])]);
}

export function catalogReported(model: string): boolean {
  return catalogEfforts.has(model) || catalogFast.has(model);
}

function hardcodedCapabilities(model: string): { effort: Effort[]; fast: boolean } {
  if (claudeFull.has(model)) return { effort: [...full], fast: claudeFast.has(model) };
  if (claudeFour.has(model)) return { effort: full.filter((e) => e !== "xhigh"), fast: false };
  if (codexFull.has(model)) return { effort: [...full], fast: true };
  if (model === "gpt-5.5") return { effort: full.filter((e) => e !== "max"), fast: true };
  return { effort: [], fast: false };
}
