import { AsyncLocalStorage } from "node:async_hooks";
import { BUILD_ID, usageEvent } from "../config";
import type { CompleteRequest, Provider } from "./provider";
import { diagnoseModelError, ModelRequestError } from "./errors";

type Trace = NonNullable<CompleteRequest["trace"]>;
const scope = new AsyncLocalStorage<{ trace: Trace; id?: string; pending: Promise<void>[] }>();
export const usageScope = <T>(trace: Trace, action: () => Promise<T>): Promise<T> => scope.run({ trace, pending: [] }, action);

export function recordRetry(provider: string, event: unknown): void {
  // Retry events contain only locally constructed enums/counts/timestamps.
  const current = scope.getStore();
  const saved = usageEvent({ kind: "retry", provider, event, ...current?.trace, requestId: current?.id });
  current?.pending.push(saved);
}

export function metered(provider: Provider): Provider {
  const identity = { provider: provider.name, account: provider.account };
  const failure = (error: unknown) => error instanceof ModelRequestError ? { errorKind: error.kind, errorReason: error.reason, httpStatus: error.status, oauthStatus: error.oauthStatus } : {};
  const attributed = (error: unknown) => {
    if (provider.account && error instanceof ModelRequestError) {
      const signIn = error.reason === "authentication" || error.reason === "credentials-invalid"
        || (error.reason === "oauth-http" && [400, 401, 403].includes(error.oauthStatus ?? 0));
      const [name, profile] = provider.account.split(":");
      const hint = signIn && profile ? ` Run /login ${name} ${profile}.` : "";
      error.message = `${provider.account}: ${error.message}${hint}`;
    }
    return error;
  };
  return { ...provider,
    ...(provider.search ? { search: async (request: Parameters<NonNullable<Provider["search"]>>[0]) => {
      const started = performance.now(), trace = scope.getStore()?.trace;
      try {
        const result = await provider.search!(request);
        await usageEvent({ kind: "model", ...trace, purpose: "web-search", ...identity, model: request.model, ok: true, durationMs: performance.now() - started });
        return result;
      } catch (error) {
        await usageEvent({ kind: "model", ...trace, purpose: "web-search", ...identity, model: request.model, ok: false, ...failure(error), durationMs: performance.now() - started });
        throw attributed(error);
      }
    } } : {}),
    complete(request) {
      const started = performance.now(), id = crypto.randomUUID(), trace = request.trace ?? scope.getStore()?.trace ?? {};
      return scope.run({ trace, id, pending: [] }, async () => {
        try {
          const result = await provider.complete(request);
          await usageEvent({ kind: "model", id, ...identity, model: request.model, ...trace,
            durationMs: Math.round(performance.now() - started), usage: result.usage, stop: result.stop,
            build: BUILD_ID, toolCalls: result.content.filter(block => block.type === "tool_use").length,
            contextTokens: result.inputTokens, ok: true });
          return result;
        } catch (cause) {
          const error = provider.account && !request.signal?.aborted ? diagnoseModelError(cause) : cause;
          await usageEvent({ kind: "model", id, ...identity, model: request.model, ...trace,
            durationMs: Math.round(performance.now() - started), build: BUILD_ID, ok: false, ...failure(error), cancelled: request.signal?.aborted === true });
          throw attributed(error);
        } finally { await Promise.all(scope.getStore()!.pending); }
      });
    },
  };
}
