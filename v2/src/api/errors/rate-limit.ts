import { z } from "zod";
import { paths, readState, updateState } from "../../config";
import type { RequestScope } from "./bounded-transport";

const cooldownShape = z.object({ until: z.number(), probeAt: z.number(), failures: z.number(), version: z.string() });
type Cooldown = z.infer<typeof cooldownShape>;
const rateLimited = z.object({ status: z.literal(429), headers: z.unknown().optional() });
const headerRecord = z.object({ "retry-after": z.unknown().optional() });

function cooldown(value: unknown): Cooldown | undefined {
  const parsed = cooldownShape.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
const key = "cooldown";
const LOCKOUT_MS = 60_000;
export function lockoutUntil(source: unknown, now = Date.now()): number | undefined {
  const parsed = rateLimited.safeParse(source);
  if (!parsed.success) return undefined;
  const headers = parsed.data.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const record = headerRecord.safeParse(headers);
  const header = headers instanceof Headers ? headers.get("retry-after") : record.success ? record.data["retry-after"] : undefined;
  const until = retryAt(typeof header === "string" ? header : null, now, 1);
  return until - now > LOCKOUT_MS ? until : undefined;
}
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined || signal === null) { setTimeout(resolve, ms); return; }
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
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
      admitted = cooldown(readState<unknown>(paths.memory, scope, key));
      if (admitted === undefined) break;
      const now = Date.now();
      if (admitted.until - now > LOCKOUT_MS) break;
      let delay = 0;
      updateState<unknown>(paths.memory, scope, key, stored => {
        const old = cooldown(stored);
        if (old === undefined) { admitted = undefined; return undefined; }
        delay = Math.max(old.until, old.probeAt) - Date.now();
        admitted = old;
        return delay > 0 ? old : { ...old, probeAt: Date.now() + 1000 };
      });
      if (delay <= 0) break;
      await wait(Math.min(delay, 1000), signal);
    }
    const response = await transport(input, init);
    if (lockoutUntil(response) !== undefined) return response;
    if (response.status === 429) updateState<unknown>(paths.memory, scope, key, stored => {
      const old = cooldown(stored);
      const failures = (old?.failures ?? 0) + 1, until = retryAt(response.headers.get("retry-after"), Date.now(), failures);
      return { until: Math.max(until, old?.until ?? 0), probeAt: Math.max(until, old?.probeAt ?? 0), failures, version: crypto.randomUUID() };
    });
    else if (response.ok && admitted !== undefined) {
      const version = admitted.version;
      updateState<unknown>(paths.memory, scope, key, stored => cooldown(stored)?.version === version ? undefined : stored);
    }
    return response;
  };
}
