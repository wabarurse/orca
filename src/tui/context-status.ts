import { modelContextLimit } from "../model-context";
import { validRounds } from "../config";
const k = (n: number) => `${Number((n / 1000).toFixed(1))}k`;
/** ~ explicitly distinguishes byte-based budgeting from provider tokenization. */
export function contextStatus(model: string | undefined, used?: number): string {
  const limit = model ? modelContextLimit(model) : undefined;
  return `ctx ${used !== undefined && Number.isFinite(used) && used >= 0 ? `~${k(used)}` : "?"}/${limit ? k(limit) : "?"}`;
}
/** The saved global limit, not the number of reviews any task has received. */
export function reviewStatus(maxReviewRounds: number | undefined): string {
  return `review rounds: ${validRounds(maxReviewRounds) ? maxReviewRounds : "?"}`;
}
