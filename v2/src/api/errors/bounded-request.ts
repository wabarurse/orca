import { transportAttempt, type RequestScope } from "./bounded-transport";
import { withTransientRetries, type RetryOptions } from "./retry";
import { diagnoseModelError, ModelRequestError, type RequestStage } from "./model-diagnostics";
export { ModelRequestError } from "./model-diagnostics";

export const MODEL_REQUEST_LIMITS = { totalMs: 600_000, idleMs: 90_000 } as const;
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
  const caller = options.signal;
  const callerAbort = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", callerAbort, { once: true });
  const total = setTimeout(() => controller.abort(new ModelRequestError("total-timeout")), totalMs);
  const abortion = Promise.withResolvers<never>();
  const aborted = abortion.promise;
  const onAbort = () => abortion.reject(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  return { controller, aborted, activity, stopIdle, close() {
    clearTimeout(total); stopIdle();
    options.signal?.removeEventListener("abort", callerAbort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  } };
}

async function runAttempt<T>(execute: (scope: RequestScope) => Promise<T>, deadline: ReturnType<typeof requestDeadline>, transport: RequestScope["fetch"], started: () => void): Promise<T> {
  deadline.controller.signal.throwIfAborted();
  deadline.activity();
  const attempt = transportAttempt(deadline.controller, transport, deadline.activity, started);
  try { return await execute(attempt.scope); }
  finally {
    await attempt.close();
    deadline.stopIdle();
  }
}

export async function boundedModelRequest<T>(execute: (scope: RequestScope) => Promise<T>, options: Options = {}, transport: RequestScope["fetch"] = fetch): Promise<T> {
  const deadline = requestDeadline(options);
  const { signal } = deadline.controller;
  let consumed = false;
  let stage: RequestStage = "setup";
  const attempt = (started: () => void) => {
    stage = "setup";
    return runAttempt(execute, deadline, async (input, init) => {
      stage = "connection";
      const response = await transport(input, init);
      stage = "response";
      return response;
    }, () => { consumed = true; started(); });
  };
  try {
    return await Promise.race([deadline.aborted, withTransientRetries(attempt, {
      signal, backoffMs: options.backoffMs, onRetry: options.onRetry, notice: () => {},
    })]);
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (signal.aborted) throw signal.reason;
    throw diagnoseModelError(error, consumed, stage);
  } finally { deadline.close(); }
}
