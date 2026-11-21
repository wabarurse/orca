import { boundedModelRequest } from "./bounded-request";
import type { RequestScope } from "./bounded-transport";
import { withTransientRetries, type RetryOptions } from "./retry";
import { coordinatedTransport } from "./rate-limit";

export type RecoveryPolicy = {
  enabled: true;
  account?: string;
  idleMs?: number;
  totalMs?: number;
  onRetry?: RetryOptions["onRetry"];
};

export function providerRequest<T>(
  policy: RecoveryPolicy | undefined,
  execute: (started: () => void, scope?: RequestScope) => Promise<T>,
  options: RetryOptions,
  transport?: RequestScope["fetch"],
): Promise<T> {
  if (policy === undefined) return withTransientRetries(started => execute(started), options);
  return boundedModelRequest(scope => execute(() => {}, scope), {
    ...options, ...policy,
    onRetry(event) {
      try { options.notice?.(`model request failed (${event.reason}); retrying: attempt ${event.attempt}, nextRetryAt ${event.nextRetryAt}`); } catch {}
      policy.onRetry?.(event);
    },
  }, policy.account !== undefined && policy.account !== "" ? coordinatedTransport(policy.account, transport ?? fetch) : transport);
}
