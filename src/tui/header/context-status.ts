import { contextWindow, type ContextWindow } from "../../providers/catalog";
import { validRounds } from "../../config";
/** One-decimal trimmed k below 1M; M from 1M, including values that would round to 1000k. */
const k = (n: number) => {
  const thousands = Number((n / 1000).toFixed(1));
  return thousands < 1000 ? `${thousands}k` : `${Number((n / 1e6).toFixed(1))}M`;
};
/** ~ explicitly distinguishes byte-based budgeting from provider tokenization. The limit is
 * the one compaction uses (window from the session when given); a trailing ? marks a fallback estimate. */
export function contextStatus(model: string | undefined, used?: number, window?: ContextWindow): string {
  const limit = model ? window ?? contextWindow({}, model) : undefined;
  return `ctx ${used !== undefined && Number.isFinite(used) && used >= 0 ? `~${k(used)}` : "?"}/${limit ? `${k(limit.limit)}${limit.estimated ? "?" : ""}` : "?"}`;
}
/** The saved global limit, not the number of reviews any task has received. */
export function reviewStatus(maxReviewRounds: number | undefined): string {
  return `review rounds: ${validRounds(maxReviewRounds) ? maxReviewRounds : "?"}`;
}
/** The saved global /dynamic-dispatch switch; unknown until a read succeeds. */
export function dispatchStatus(on: boolean | undefined): string {
  return `dispatch: ${on === undefined ? "?" : on ? "on" : "off"}`;
}
