/** Standard context windows only, never opt-in/beta long-context variants. Unlisted models remain unknown.
 *
 * Codex: verified catalog snapshot, standard context_window, NOT opt-in max_context_window.
 * https://raw.githubusercontent.com/openai/codex/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/models-manager/models.json
 * Effort/fast groups establish no context limits.
 *
 * Claude: the 1M entries are the documented default window (no beta header, no [1m] variant).
 * https://platform.claude.com/docs/en/models/overview (comparison table)
 * https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-sizes-by-model
 * https://platform.claude.com/docs/en/models/{opus-5,opus-4-8,opus-4-7,sonnet-5,fable-5,opus-4-5,haiku-4-5,sonnet-4-5}/overview
 * Opus 4.6 and Sonnet 4.6 reach 1M on subscriptions only through their opt-in [1m] variant, so
 * their standard window is 200k: https://code.claude.com/docs/en/model-config#extended-context
 */
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
/** Context windows reported by provider model catalogs (/models API), in memory per process. */
const catalogLimits = new Map<string, number>();
const fetching = new Map<string, Promise<void>>();
const validLimit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Records catalog windows; null, 0, negative and non-finite values are ignored. */
export function rememberCatalogLimits(entries: Iterable<readonly [string, unknown]>): void {
  for (const [model, limit] of entries) if (validLimit(limit)) catalogLimits.set(model, limit);
}

/** Fetches a provider's catalog (windows and effort levels) once per process. Turns never await it and
 * failures are silent and retried later; the returned promise never rejects, so a picker may wait on it. */
export function prefetchContextLimits(provider: { name: string; models(): Promise<unknown> }): Promise<void> {
  const known = fetching.get(provider.name);
  if (known) return known;
  const run = Promise.resolve().then(() => provider.models()).then(() => {}, () => { fetching.delete(provider.name); });
  fetching.set(provider.name, run);
  return run;
}

export function clearCatalogLimits(): void {
  catalogLimits.clear();
  fetching.clear();
  clearCatalogEfforts();
}

/** Verified table first (dated snapshot ids use their base model's entry); catalog values
 * fill gaps and never exceed the standard window, so opt-in 1M never replaces 200k. */
export function modelContextLimit(model: string): number | undefined {
  const standard = standardWindows[model] ?? standardWindows[model.replace(/-\d{8}$/, "")];
  const catalog = catalogLimits.get(model);
  if (catalog === undefined) return standard;
  return standard === undefined ? catalog : Math.min(standard, catalog);
}

export interface ContextWindow { limit: number; estimated: boolean }
const DEFAULT_LIMIT = 128000;
/** The one limit resolution shared by compaction and the header. estimated: no explicit
 * budget and no verified or catalog model window, so the configured/default fallback applies. */
export function contextWindow(options: { contextLimit?: number; fallback?: number }, model = ""): ContextWindow {
  const known = options.contextLimit ?? modelContextLimit(model);
  const n = known ?? options.fallback ?? DEFAULT_LIMIT;
  return Number.isFinite(n) && n > 0 ? { limit: n, estimated: known === undefined } : { limit: DEFAULT_LIMIT, estimated: true };
}
