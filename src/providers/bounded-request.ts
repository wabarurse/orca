import { exhaustedQuota, transientFailure, withTransientRetries, type RetryOptions } from "./retry";

export const MODEL_REQUEST_LIMITS = { totalMs: 600_000, idleMs: 90_000 } as const;
export class ModelRequestError extends Error {
  constructor(readonly kind: "total-timeout" | "idle-timeout" | "quota" | "interrupted" | "exhausted" | "permanent") {
    super(`Model request ${kind}. Check connection or provider account/settings, then explicitly resume; no automatic fallback.`);
    this.name = "ModelRequestError";
  }
}
type Options = Pick<RetryOptions, "signal" | "backoffMs" | "onRetry"> & { totalMs?: number; idleMs?: number };
type Scope = { signal: AbortSignal; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

/** DORMANT: not imported by providers. One executor owns the whole completion, not just headers.
 * Integration MUST disable SDK retries, preserve deliberate 401 refresh separately, use scoped fetch
 * and signal, and await stream completion. Never nest this around existing withTransientRetries.
 * Headers and nonempty transport bytes (including SSE heartbeat/reasoning/tools) reset idle;
 * any successful-response body byte conservatively forbids replay. SDK text callbacks are not activity clocks.
 * Total includes backoff and cannot be extended by activity. Idle pauses during backoff.
 * 10m/90s favor long reasoning over fast detection; silent-but-healthy providers can time out.
 * Deadlines are terminal. An executor ignoring abort may remain pending, but is NEVER duplicated.
 */
export async function boundedModelRequest<T>(execute: (scope: Scope) => Promise<T>, options: Options = {}, transport: Scope["fetch"] = fetch): Promise<T> {
  const totalMs = options.totalMs ?? MODEL_REQUEST_LIMITS.totalMs;
  const idleMs = options.idleMs ?? MODEL_REQUEST_LIMITS.idleMs;
  for (const ms of [totalMs, idleMs]) if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new RangeError("Invalid model request deadline");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const { signal } = controller;
  let consumed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stopIdle = () => clearTimeout(idle);
  const activity = () => {
    stopIdle();
    if (!signal.aborted) idle = setTimeout(() => controller.abort(new ModelRequestError("idle-timeout")), idleMs);
  };
  const callerAbort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const total = setTimeout(() => controller.abort(new ModelRequestError("total-timeout")), totalMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([aborted, withTransientRetries(async started => {
      signal.throwIfAborted();
      activity();
      const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
      const cancel = () => { for (const reader of readers) void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await execute({ signal, fetch: async (input, init) => {
          signal.throwIfAborted();
          const response = await transport(input, { ...init, signal });
          if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
          activity();
          if (!response.body) return response;
          const reader = response.body.getReader();
          readers.add(reader);
          const body = new ReadableStream<Uint8Array>({
            async pull(output) {
              try {
                const chunk = await reader.read();
                signal.throwIfAborted();
                if (chunk.done) { readers.delete(reader); reader.releaseLock(); output.close(); }
                else { if (chunk.value.byteLength) { if (response.ok) { consumed = true; started(); } activity(); } output.enqueue(chunk.value); }
              } catch (error) { output.error(error); }
            },
            cancel: () => reader.cancel(),
          }, { highWaterMark: 0 });
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        } });
      } finally {
        stopIdle();
        cancel();
        signal.removeEventListener("abort", cancel);
      }
    }, { signal, backoffMs: options.backoffMs, onRetry: options.onRetry, notice: () => {} })]);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (signal.aborted) throw signal.reason;
    // Existing retry helper maps quota to a sanitized Error; preserve category without payloads.
    if (exhaustedQuota(error) || (error instanceof Error && error.message.startsWith("model: quota exhausted"))) throw new ModelRequestError("quota");
    throw new ModelRequestError(consumed ? "interrupted" : transientFailure(error) ? "exhausted" : "permanent");
  } finally {
    clearTimeout(total); stopIdle();
    options.signal?.removeEventListener("abort", callerAbort);
    signal.removeEventListener("abort", onAbort);
    controller.abort(); // Also closes cooperative HTTP on success or permanent failure.
  }
}
