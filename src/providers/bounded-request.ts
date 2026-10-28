import { transportAttempt, type RequestScope } from "./bounded-transport";
import { exhaustedQuota, transientFailure, withTransientRetries, type RetryOptions } from "./retry";

export const MODEL_REQUEST_LIMITS = { totalMs: 600_000, idleMs: 90_000 } as const;
export class ModelRequestError extends Error {
  constructor(readonly kind: "total-timeout" | "idle-timeout" | "quota" | "interrupted" | "exhausted" | "permanent") {
    super(`Model request ${kind}. Check connection or provider account/settings, then explicitly resume; no automatic fallback.`);
    this.name = "ModelRequestError";
  }
}
type Options = Pick<RetryOptions, "signal" | "backoffMs" | "onRetry"> & { totalMs?: number; idleMs?: number };

function requestDeadline(options: Options) {
  const totalMs = options.totalMs ?? MODEL_REQUEST_LIMITS.totalMs;
  const idleMs = options.idleMs ?? MODEL_REQUEST_LIMITS.idleMs;
  for (const ms of [totalMs, idleMs]) if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new RangeError("Invalid model request deadline");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stopIdle = () => clearTimeout(idle);
  const activity = () => {
    stopIdle();
    if (!controller.signal.aborted) idle = setTimeout(() => controller.abort(new ModelRequestError("idle-timeout")), idleMs);
  };
  const callerAbort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const total = setTimeout(() => controller.abort(new ModelRequestError("total-timeout")), totalMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  return { controller, aborted, activity, stopIdle, close() {
    clearTimeout(total); stopIdle();
    options.signal?.removeEventListener("abort", callerAbort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  } };
}

function terminalError(error: unknown, consumed: boolean): ModelRequestError {
  // Existing retry helper maps quota to a sanitized Error; never include raw payloads.
  if (exhaustedQuota(error) || (error instanceof Error && error.message.startsWith("model: quota exhausted"))) return new ModelRequestError("quota");
  return new ModelRequestError(consumed ? "interrupted" : transientFailure(error) ? "exhausted" : "permanent");
}

async function runAttempt<T>(execute: (scope: RequestScope) => Promise<T>, deadline: ReturnType<typeof requestDeadline>, transport: RequestScope["fetch"], started: () => void): Promise<T> {
  deadline.controller.signal.throwIfAborted();
  deadline.activity();
  const attempt = transportAttempt(deadline.controller, transport, deadline.activity, started);
  try { return await execute(attempt.scope); }
  finally {
    // Abort HTTP and await cooperative reader cleanup BEFORE allowing a retry. The outer
    // deadline race still terminates hung cleanup; its aborted signal forbids a replacement.
    await attempt.close();
    deadline.stopIdle();
  }
}

/** Enabled by the account factories. One executor owns the whole completion, not just headers.
 * Integration MUST disable SDK retries, preserve deliberate 401 refresh separately, use scoped fetch
 * and signal, and await stream completion. Never nest this around existing withTransientRetries.
 * Headers and nonempty transport bytes (including SSE heartbeat/reasoning/tools) reset idle;
 * any successful-response body byte conservatively forbids replay. SDK text callbacks are not activity clocks.
 * Total includes backoff and cannot be extended by activity. Idle pauses during backoff.
 * 10m/90s favor long reasoning over fast detection; silent-but-healthy providers can time out.
 * Deadlines are terminal. An executor ignoring abort may remain pending, but is NEVER duplicated.
 */
export async function boundedModelRequest<T>(execute: (scope: RequestScope) => Promise<T>, options: Options = {}, transport: RequestScope["fetch"] = fetch): Promise<T> {
  const deadline = requestDeadline(options);
  const { signal } = deadline.controller;
  let consumed = false;
  const attempt = (started: () => void) => runAttempt(execute, deadline, transport, () => { consumed = true; started(); });
  try {
    return await Promise.race([deadline.aborted, withTransientRetries(attempt, {
      signal, backoffMs: options.backoffMs, onRetry: options.onRetry, notice: () => {},
    })]);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (signal.aborted) throw signal.reason;
    throw terminalError(error, consumed);
  } finally { deadline.close(); }
}
