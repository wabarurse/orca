import { clearCatalogEfforts } from "./capabilities";

const standardWindows: Readonly<Record<string, number>> = {
  "gpt-6-astra": 272000,
  "gpt-6.1-sol": 272000,
  "gpt-6-sol": 272000,
  "gpt-6-luna": 272000,
  "gpt-5.6-sol": 272000,
  "gpt-5.6-terra": 272000,
  "gpt-5.6-luna": 272000,
  "gpt-daybreak-blue-latest": 272000,
  "gpt-daybreak-red-latest": 372000,
  "gpt-5.5": 272000,
  "codex-auto-review": 272000,
  "claude-fable-5-1": 1000000,
  "claude-fable-5": 1000000,
  "claude-opus-5-5": 1000000,
  "claude-opus-5": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-4-7": 1000000,
  "claude-sonnet-5-5": 1000000,
  "claude-sonnet-5": 1000000,
  "claude-haiku-5-5": 1000000,
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-opus-4-5": 200000,
  "claude-sonnet-4-5": 200000,
  "claude-haiku-4-5": 200000,
};
const catalogLimits = new Map<string, number>();
const fetching = new Map<string, Promise<void>>();
const validLimit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function rememberCatalogLimits(entries: Iterable<readonly [string, unknown]>): void {
  for (const [model, limit] of entries) if (validLimit(limit)) catalogLimits.set(model, limit);
}

export const catalogLimitEntries = (): [string, number][] => [...catalogLimits];

export function prefetchContextLimits(provider: { name: string; models(): Promise<unknown> }): Promise<void> {
  const known = fetching.get(provider.name);
  if (known !== undefined) return known;
  const run = Promise.resolve().then(() => provider.models()).then(() => {}, () => { fetching.delete(provider.name); });
  fetching.set(provider.name, run);
  return run;
}

export function clearCatalogLimits(): void {
  catalogLimits.clear();
  fetching.clear();
  clearCatalogEfforts();
}

export function modelContextLimit(model: string): number | undefined {
  const standard = standardWindows[model] ?? standardWindows[model.replace(/-\d{8}$/, "")];
  const catalog = catalogLimits.get(model);
  if (catalog === undefined) return standard;
  return standard === undefined ? catalog : Math.min(standard, catalog);
}

export type ContextWindow = { limit: number; estimated: boolean };
const DEFAULT_LIMIT = 128000;
export function contextWindow(options: { contextLimit?: number; fallback?: number }, model = ""): ContextWindow {
  const known = options.contextLimit ?? modelContextLimit(model);
  const n = known ?? options.fallback ?? DEFAULT_LIMIT;
  return Number.isFinite(n) && n > 0 ? { limit: n, estimated: known === undefined } : { limit: DEFAULT_LIMIT, estimated: true };
}
