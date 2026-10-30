// Account-wide retry admission shared by all Orca processes. Healthy requests
// stay concurrent; only rate-limited accounts coordinate their recovery probes.
import { paths, readState, updateState } from "../config";
import type { RequestScope } from "./bounded-transport";

interface Cooldown { until: number; probeAt: number; failures: number; version: string }
const key = "cooldown";
export class AccountCooldownError extends Error {
  readonly status = 429;
  constructor(readonly until: number) { super(`account rate limited until ${new Date(until).toISOString()}; explicitly resume afterward`); }
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
function retryAt(response: Response, now: number, failures: number): number {
  const header = response.headers.get("retry-after");
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
      if (admitted.until - now > 60000) throw new AccountCooldownError(admitted.until);
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
    if (response.status === 429) updateState<Cooldown>(paths.memory, scope, key, old => {
      const failures = (old?.failures ?? 0) + 1, until = retryAt(response, Date.now(), failures);
      return { until: Math.max(until, old?.until ?? 0), probeAt: Math.max(until, old?.probeAt ?? 0), failures, version: crypto.randomUUID() };
    });
    else if (response.ok && admitted) updateState<Cooldown>(paths.memory, scope, key, old => old?.version === admitted?.version ? undefined : old);
    return response;
  };
}
