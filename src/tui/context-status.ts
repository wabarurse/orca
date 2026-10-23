import { sessionId } from "../runner";
import { modelContextLimit } from "../model-context";
import type { TaskRow } from "../tasks";
const k = (n: number) => `${Number((n / 1000).toFixed(1))}k`;
/** ~ explicitly distinguishes byte-based budgeting from provider tokenization. */
export function contextStatus(model: string | undefined, used?: number): string {
  const limit = model ? modelContextLimit(model) : undefined;
  return `Ctx ${used !== undefined && Number.isFinite(used) && used >= 0 ? `~${k(used)}` : "?"}/${limit ? k(limit) : "?"}`;
}
export function reviewStatus(tasks: TaskRow[] | undefined, agent?: string): string {
  if (!tasks) return "Review ?";
  const selected = agent ? tasks.filter(t => agent === sessionId("worker", t.branch) || agent === sessionId("reviewer", t.branch)) : tasks;
  if (!selected.length) return "Review —";
  if (selected.length !== 1) return `Review · ${selected.length} tasks`;
  const review = selected[0]!.review;
  return `Review ${!review || review.unknown ? "?" : review.rounds}${review?.ci ? " · CI" : ""}`;
}
