import { plain } from "./sanitize";

// One retry policy for both SDK clients: a transient failure of the initial
// request (the connection, or a 408/409/429/5xx answer) is tried again a bounded
// number of times; a stream that has begun is never retried, since its text has
// already been shown. Aborting the request's signal stops at once, mid-wait too.

/** Waits before the 1st, 2nd and 3rd retry; each is jittered by ±25%. */
export const RETRY_BACKOFF_MS = [1_000, 4_000, 10_000];
const TRANSIENT_STATUSES = new Set([408, 409, 429, 529]);
const TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused", "ConnectionClosed", "UND_ERR_SOCKET"]);
const TRANSPORT_MESSAGES = /socket connection was closed|unable to connect|connection error|request timed out|fetch failed|network|operation was aborted|request was aborted|ECONNRESET|ETIMEDOUT|EPIPE/i;

export interface RetryOptions {
  signal?: AbortSignal;
  /** Sanitized metadata only; optional observers cannot change retry behavior. */
  onRetry?: (event: { reason: "http" | "transport"; attempt: number; nextRetryAt: number }) => void;
  /** Names the request in notices ("claude", "codex"). */
  what?: string;
  model?: string;
  /** Each retry, announced: a plain transcript status line when the request has one, else a dim stderr line. */
  notice?: (text: string) => void;
  /** Tests shorten the waits. */
  backoffMs?: number[];
}

/**
 * The reason a failed request may be tried again, or undefined when it may not: a transport error anywhere in
 * the cause chain (a closed socket, a refused or reset connection, a timeout, an abort that was not ours), or a
 * response the SDK turned into an error with a 408/409/429/529 or 5xx status. Any other 4xx (auth, validation,
 * context size) is final.
 */
export function transientFailure(error: unknown): string | undefined {
  if (exhaustedQuota(error)) return undefined;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return TRANSIENT_STATUSES.has(status) || status >= 500 ? `HTTP ${status}` : undefined;
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) return describe(e);
    if (e.name === "AbortError" || TRANSPORT_MESSAGES.test(e.message)) return describe(e);
  }
  return undefined;
}
const describe = (e: Error) => e.message.split(/[.\n]/)[0]!.trim().toLowerCase() || e.name;

/**
 * Run `attempt` and, on a transient failure before the response was consumed, run it again after a backoff.
 * `attempt` calls `started()` when the first streamed event arrives; a failure after that is rethrown as it is,
 * never retried. When `signal` aborts, the abort reason is thrown at once, whether mid-request or mid-wait.
 */
export async function withTransientRetries<T>(attempt: (started: () => void) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, what = "model", backoffMs = RETRY_BACKOFF_MS } = options;
  const notice = options.notice ?? (text => { console.error(`\x1b[2m${text}\x1b[0m`); });
  for (let retries = 0; ; retries++) {
    signal?.throwIfAborted();
    let consumed = false;
    try { return await attempt(() => { consumed = true; }); }
    catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const quota = exhaustedQuota(error);
      if (quota) throw new Error(`${plain(what)}${options.model ? ` (${plain(options.model)})` : ""}: quota exhausted — ${quota}`);
      const wait = retryAfter(error, consumed, retries, backoffMs);
      if (wait === undefined) throw error;
      try { options.onRetry?.({ reason: typeof (error as { status?: unknown })?.status === "number" ? "http" : "transport", attempt: retries + 2, nextRetryAt: Date.now() + wait }); } catch {}
      notice(retryNotice(what, transientFailure(error)!, wait, retries + 1, backoffMs.length));
      await sleep(wait, signal);
    }
  }
}

/** The jittered wait before retry `retries + 1`, or undefined when the failure is final: the stream had begun, the error is not transient, or the retries are spent. */
function retryAfter(error: unknown, consumed: boolean, retries: number, backoffMs: number[]): number | undefined {
  if (consumed || retries >= backoffMs.length || transientFailure(error) === undefined) return undefined;
  return Math.round(backoffMs[retries]! * (0.75 + Math.random() * 0.5));
}

/** The one wording of a retry's announcement; the TUI classifies transient notices by it. */
export function retryNotice(what: string, reason: string, waitMs: number, n: number, of: number): string {
  return `${what} request failed (${reason}); retrying in ${(waitMs / 1000).toFixed(waitMs < 1000 ? 2 : 0)}s (${n}/${of})`;
}

/** Resolves after `ms`, or rejects with the signal's reason (at once when it is already aborted). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Only explicit structured provider evidence, never status or transport/message guesses.
 * Explanations are mapped rather than echoing untrusted bodies (which can contain secrets).
 */
export function exhaustedQuota(error: unknown): string | undefined {
  const evidence = quotaEvidence(error);
  if (!evidence) return undefined;
  const explanation = quotaExplanation(evidence);
  return explanation ? explanation + quotaReset(evidence.resets_at) : undefined;
}

type ErrorRecord = Record<string, unknown>;
const errorRecord = (value: unknown): ErrorRecord | undefined =>
  value !== null && typeof value === "object" ? value as ErrorRecord : undefined;

/** Prefer the nested payload over SDK-copied fields, retaining its reset timestamp.
 * Inspect at most four envelopes, including the initial error; cycles are bounded too.
 */
function quotaEvidence(error: unknown): ErrorRecord | undefined {
  let evidence = errorRecord(error);
  for (let depth = 0; evidence && depth < 4; depth++) {
    const nested = errorRecord(evidence.error) ?? errorRecord(errorRecord(evidence.response)?.error);
    if (!nested) return evidence;
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
  // Anthropic reports exhausted prepaid credits as invalid_request_error, not 429.
  if (code === "invalid_request_error" && typeof evidence.message === "string" &&
      /^Your credit balance is too low to access the Anthropic API\b/i.test(evidence.message))
    return "the provider reports insufficient credits.";
  return undefined;
}

/** Codex's resets_at is Unix seconds. Never infer a reset from Retry-After. */
function quotaReset(reset: unknown): string {
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset >= 253402300800)
    return "";
  return ` Reset: ${new Date(reset * 1000).toISOString()}.`;
}
