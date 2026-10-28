import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config";
import type { CompleteRequest, Provider } from "./provider";

type Trace = NonNullable<CompleteRequest["trace"]>;
const scope = new AsyncLocalStorage<{ trace: Trace; id?: string; pending: Promise<void>[] }>();
export const usageScope = <T>(trace: Trace, action: () => Promise<T>): Promise<T> => scope.run({ trace, pending: [] }, action);

/** Append-only accounting: no prompts, command text, credentials or provider error bodies. */
export async function usageEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    await appendFile(join(paths.runtime, "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch { console.warn("orca: usage recording unavailable; execution continues"); }
}

export function recordRetry(provider: string, event: unknown): void {
  // Retry events contain only locally constructed enums/counts/timestamps.
  const current = scope.getStore();
  const saved = usageEvent({ kind: "retry", provider, event, ...current?.trace, requestId: current?.id });
  current?.pending.push(saved);
}

export function metered(provider: Provider): Provider {
  return { ...provider,
    ...(provider.search ? { search: async (request: Parameters<NonNullable<Provider["search"]>>[0]) => {
      const started = performance.now(), trace = scope.getStore()?.trace;
      try {
        const result = await provider.search!(request);
        await usageEvent({ kind: "model", ...trace, purpose: "web-search", provider: provider.name, model: request.model, ok: true, durationMs: performance.now() - started });
        return result;
      } catch (error) {
        await usageEvent({ kind: "model", ...trace, purpose: "web-search", provider: provider.name, model: request.model, ok: false, durationMs: performance.now() - started });
        throw error;
      }
    } } : {}),
    complete(request) {
      const started = performance.now(), id = crypto.randomUUID(), trace = request.trace ?? scope.getStore()?.trace ?? {};
      return scope.run({ trace, id, pending: [] }, async () => {
        try {
          const result = await provider.complete(request);
          await usageEvent({ kind: "model", id, provider: provider.name, model: request.model, ...trace,
            durationMs: Math.round(performance.now() - started), usage: result.usage, stop: result.stop,
            contextTokens: result.inputTokens, ok: true });
          return result;
        } catch (error) {
          await usageEvent({ kind: "model", id, provider: provider.name, model: request.model, ...trace,
            durationMs: Math.round(performance.now() - started), ok: false, cancelled: request.signal?.aborted === true });
          throw error;
        } finally { await Promise.all(scope.getStore()!.pending); }
      });
    },
  };
}
