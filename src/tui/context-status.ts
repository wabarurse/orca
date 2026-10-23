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
  if (selected.length !== 1) {
    // Exclusive round buckets plus an overlapping CI count: no invented focus
    // or shared denominator, and bounded width regardless of round diversity.
    const counts = [0, 0, 0, 0];
    let ci = 0;
    for (const task of selected) {
      const r = task.review;
      counts[!r || r.unknown ? 3 : Math.min(2, r.rounds)]!++;
      if (r?.ci) ci++;
    }
    return `Reviews 0r:${counts[0]} 1r:${counts[1]} 2+r:${counts[2]} ?:${counts[3]} CI:${ci}`;
  }
  const review = selected[0]!.review;
  return `Review ${!review || review.unknown ? "?" : review.rounds}${review?.ci ? " · CI" : ""}`;
}
