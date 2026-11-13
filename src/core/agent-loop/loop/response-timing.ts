import { BUILD_ID } from "../../../config";
import { usageEvent } from "../../../config";
import type { Message } from "../../../protocol";

type Outcome = "text" | "tool" | "settled" | "failed" | "cancelled";

export function responseTiming(project: string) {
  let current: { consumed: number; queuedMs?: number; inputCount: number; provider?: number } | undefined;
  const writes: Promise<void>[] = [];
  const elapsed = (from: number, to: number) => Math.round(to - from);

  function record(outcome: Outcome) {
    if (!current) return;
    const { consumed, queuedMs, inputCount, provider } = current;
    current = undefined;
    const now = performance.now();
    writes.push(usageEvent({ kind: "response-latency", build: BUILD_ID, project, agent: "orchestrator",
      outcome, inputCount, queuedMs, consumedToProviderMs: provider === undefined ? undefined : elapsed(consumed, provider),
      providerToOutcomeMs: provider === undefined ? undefined : elapsed(provider, now), consumedToOutcomeMs: elapsed(consumed, now) }));
  }
  return {
    consumed(messages: Message[]) {
      const human = messages.filter(m => m.from === "user");
      if (!human.length) return;
      record("settled");
      const enqueued = human.reduce((oldest, m) => {
        const at = Date.parse(m.ts);
        return Number.isFinite(at) ? Math.min(oldest, at) : oldest;
      }, Infinity);
      current = { consumed: performance.now(), inputCount: human.length,
        queuedMs: Number.isFinite(enqueued) ? Math.max(0, Date.now() - enqueued) : undefined };
    },
    requested() { if (current) current.provider ??= performance.now(); },
    record,
    async finish(outcome: Outcome) { record(outcome); await Promise.all(writes); },
  };
}
export type ResponseTiming = ReturnType<typeof responseTiming>;
