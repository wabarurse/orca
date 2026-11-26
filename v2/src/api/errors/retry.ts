import { z } from "zod";
import { plain } from "../sanitize";
import { lockoutUntil } from "./rate-limit";

export const RETRY_BACKOFF_MS = [1_000, 4_000, 10_000];
const TRANSIENT_STATUSES = new Set([408, 409, 429, 529]);
const TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused", "ConnectionClosed", "UND_ERR_SOCKET"]);
const TRANSPORT_MESSAGES = /socket connection was closed|unable to connect|connection error|request timed out|fetch failed|network|operation was aborted|request was aborted|ECONNRESET|ETIMEDOUT|EPIPE/i;

export type RetryOptions = {
  signal?: AbortSignal | undefined;
  onRetry?: ((event: { reason: "http" | "transport"; attempt: number; nextRetryAt: number }) => void) | undefined;
  what?: string | undefined;
  model?: string | undefined;
  notice?: ((text: string) => void) | undefined;
  backoffMs?: number[] | undefined;
};

const withStatus = z.object({ status: z.number() });
const withCode = z.object({ code: z.string() });
const errorFields = z.object({
  error: z.unknown().optional(),
  response: z.unknown().optional(),
  code: z.unknown().optional(),
  type: z.unknown().optional(),
  message: z.unknown().optional(),
  resets_at: z.unknown().optional(),
});
export type ErrorRecord = z.infer<typeof errorFields>;

function statusOf(error: unknown): number | undefined {
  const parsed = withStatus.safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

export function transientFailure(error: unknown): string | undefined {
  if (lockoutUntil(error) !== undefined) return undefined;
  if (exhaustedQuota(error) !== undefined) return undefined;
  const status = statusOf(error);
  if (status !== undefined) return TRANSIENT_STATUSES.has(status) || status >= 500 ? `HTTP ${status}` : undefined;
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = withCode.safeParse(e);
    if (code.success && TRANSPORT_CODES.has(code.data.code)) return describe(e);
    if (e.name === "AbortError" || TRANSPORT_MESSAGES.test(e.message)) return describe(e);
  }
  return undefined;
}
const describe = (e: Error) => {
  const first = (e.message.split(/[.\n]/)[0] ?? "").trim().toLowerCase();
  return first !== "" ? first : e.name;
};

export async function withTransientRetries<T>(attempt: (started: () => void) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, what = "model", backoffMs = RETRY_BACKOFF_MS } = options;
  const notice = options.notice ?? (text => { console.error(`\x1b[2m${text}\x1b[0m`); });
  for (let retries = 0; ; retries++) {
    signal?.throwIfAborted();
    let consumed = false;
    try { return await attempt(() => { consumed = true; }); }
    catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
      const quota = exhaustedQuota(error);
      const model = options.model;
      if (quota !== undefined) throw new QuotaError(`${plain(what)}${model !== undefined && model !== "" ? ` (${plain(model)})` : ""}: quota exhausted — ${quota}`, quota, httpStatus(error));
      const reason = transientFailure(error);
      const wait = reason === undefined ? undefined : retryAfter(consumed, retries, backoffMs);
      if (wait === undefined || reason === undefined) throw error;
      emitRetry(options, error, retries + 2, wait);
      notice(retryNotice(what, reason, wait, retries + 1, backoffMs.length));
      await sleep(wait, signal);
    }
  }
}

function emitRetry(options: RetryOptions, error: unknown, attempt: number, wait: number): void {
  const reason = statusOf(error) !== undefined ? "http" : "transport";
  try { options.onRetry?.({ reason, attempt, nextRetryAt: Date.now() + wait }); } catch {}
}

function retryAfter(consumed: boolean, retries: number, backoffMs: number[]): number | undefined {
  const base = backoffMs[retries];
  if (consumed || base === undefined) return undefined;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function retryNotice(what: string, reason: string, waitMs: number, n: number, of: number): string {
  return `${what} request failed (${reason}); retrying in ${(waitMs / 1000).toFixed(waitMs < 1000 ? 2 : 0)}s (${n}/${of})`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) { setTimeout(resolve, ms); return; }
    if (signal.aborted) { reject(signal.reason); return; }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function exhaustedQuota(error: unknown): string | undefined {
  const evidence = providerErrorEvidence(error);
  if (evidence === undefined) return undefined;
  const explanation = quotaExplanation(evidence);
  return explanation !== undefined ? explanation + quotaReset(evidence.resets_at) : undefined;
}

export class QuotaError extends Error {
  constructor(message: string, readonly explanation: string, readonly status?: number) { super(message); }
}

export function httpStatus(error: unknown): number | undefined {
  const status = statusOf(error);
  return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

const errorRecord = (value: unknown): ErrorRecord | undefined => {
  const parsed = errorFields.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export function providerErrorEvidence(error: unknown): ErrorRecord | undefined {
  let evidence = errorRecord(error);
  for (let depth = 0; evidence !== undefined && depth < 4; depth++) {
    const nested = errorRecord(evidence.error) ?? errorRecord(errorRecord(evidence.response)?.error);
    if (nested === undefined) return evidence;
    evidence = nested;
  }
  return undefined;
}

function quotaExplanation(evidence: ErrorRecord): string | undefined {
  const code = typeof evidence.code === "string" ? evidence.code : evidence.type;
  if (["insufficient_quota", "quota_exceeded", "usage_limit_reached", "usage_cap_reached"].includes(String(code)))
    return "the provider reports that the available usage allowance is exhausted.";
  if (["billing_hard_limit_reached", "billing_limit_reached", "credit_balance_too_low"].includes(String(code)))
    return "the provider reports insufficient credits or a billing cap.";
  if (code === "invalid_request_error" && typeof evidence.message === "string" &&
      /^Your credit balance is too low to access the Anthropic API\b/i.test(evidence.message))
    return "the provider reports insufficient credits.";
  return undefined;
}

function quotaReset(reset: unknown): string {
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset >= 253402300800)
    return "";
  return ` Reset: ${new Date(reset * 1000).toISOString()}.`;
}
