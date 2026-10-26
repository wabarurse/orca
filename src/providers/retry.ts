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
  /** Names the request in notices ("claude", "codex"). */
  what?: string;
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
      const reason = consumed ? undefined : transientFailure(error);
      if (reason === undefined || retries >= backoffMs.length) throw error;
      const wait = jittered(backoffMs[retries]!);
      notice(`${what} request failed (${reason}); retrying in ${(wait / 1000).toFixed(wait < 1000 ? 2 : 0)}s (${retries + 1}/${backoffMs.length})`);
      await sleep(wait, signal);
    }
  }
}

const jittered = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

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
