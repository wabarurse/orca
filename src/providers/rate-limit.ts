// Account-wide retry admission shared by all Orca processes. Healthy requests
// stay concurrent; only rate-limited accounts coordinate their recovery probes.
import { paths, readState, updateState } from "../config";
import type { RequestScope } from "./bounded-transport";

interface Cooldown { until: number; probeAt: number; failures: number; version: string }
const key = "cooldown";
/** A wait longer than this is a lockout: nothing is saved or waited for, the request fails and the next one asks the provider again. */
const LOCKOUT_MS = 60_000;
/** When a 429 (a Response, or the error an SDK made of one) says to come back, if that is a lockout away. */
export function lockoutUntil(source: unknown, now = Date.now()): number | undefined {
  const { status, headers } = (source ?? {}) as { status?: unknown; headers?: unknown };
  if (status !== 429 || !headers || typeof headers !== "object") return;
  const header = headers instanceof Headers ? headers.get("retry-after") : (headers as Record<string, unknown>)["retry-after"];
  const until = retryAt(typeof header === "string" ? header : null, now, 1);
  return until - now > LOCKOUT_MS ? until : undefined;
}
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Retry-After is scheduling evidence, never evidence of remaining account allowance. */
function retryAt(header: string | null, now: number, failures: number): number {
  const value = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(value) ? Math.max(now, value) : now + Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
}
export function coordinatedTransport(account: string, transport: RequestScope["fetch"]): RequestScope["fetch"] {
  const scope = `provider-rate:${account}`;
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let admitted: Cooldown | undefined;
    for (;;) {
      signal?.throwIfAborted();
      admitted = readState<Cooldown>(paths.memory, scope, key);
      if (!admitted) break;
      const now = Date.now();
      // A lockout saved by an older build: ask the provider; a success below clears it.
      if (admitted.until - now > LOCKOUT_MS) break;
      let delay = 0;
      updateState<Cooldown>(paths.memory, scope, key, old => {
        if (!old) { admitted = undefined; return; }
        delay = Math.max(old.until, old.probeAt) - Date.now();
        admitted = old;
        return delay > 0 ? old : { ...old, probeAt: Date.now() + 1000 };
      });
      if (delay <= 0) break;
      await wait(Math.min(delay, 1000), signal);
    }
    const response = await transport(input, init);
    if (lockoutUntil(response)) return response;
    if (response.status === 429) updateState<Cooldown>(paths.memory, scope, key, old => {
      const failures = (old?.failures ?? 0) + 1, until = retryAt(response.headers.get("retry-after"), Date.now(), failures);
      return { until: Math.max(until, old?.until ?? 0), probeAt: Math.max(until, old?.probeAt ?? 0), failures, version: crypto.randomUUID() };
    });
    else if (response.ok && admitted) updateState<Cooldown>(paths.memory, scope, key, old => old?.version === admitted?.version ? undefined : old);
    return response;
  };
}
