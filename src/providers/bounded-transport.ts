/** Internal transport scope for dormant recovery. Each attempt owns its HTTP lifetime. */
export type RequestScope = { signal: AbortSignal; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
type Cleanup = () => Promise<void>;

function responseMetadata(response: Response, source: Response): Response {
  const clone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { value: source.url }, redirected: { value: source.redirected }, type: { value: source.type },
    clone: { value: () => responseMetadata(clone(), source) },
  });
  return response;
}

function observedResponse(source: Response, signal: AbortSignal, activity: () => void, started: () => void, cleanups: Set<Cleanup>): Response {
  if (!source.body) return source;
  const reader = source.body.getReader();
  let cleaning: Promise<void> | undefined;
  // Keep cleanup registered until settled, including cancellation initiated by the consumer.
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    try { await reader.cancel(); } catch {} // Read errors are reported through the wrapper, not cleanup.
    finally { reader.releaseLock(); cleanups.delete(cleanup); signal.removeEventListener("abort", abort); }
  })();
  const abort = () => { void cleanup(); };
  cleanups.add(cleanup);
  signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) { await cleanup(); output.close(); return; }
        if (chunk.value.byteLength) { if (source.ok) started(); activity(); }
        output.enqueue(chunk.value);
      } catch (error) { output.error(error); await cleanup(); }
    },
    cancel: cleanup,
  }, { highWaterMark: 0 });
  return responseMetadata(new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers }), source);
}

/** init.signal overrides Request.signal (including explicit null); undefined inherits it. */
function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal !== undefined) return init.signal ?? undefined;
  return input instanceof Request ? input.signal : undefined;
}

export function transportAttempt(lifetime: AbortController, transport: RequestScope["fetch"], activity: () => void, started: () => void) {
  const controller = new AbortController();
  const cleanups = new Set<Cleanup>();
  const unlink: (() => void)[] = [];
  const abort = () => controller.abort(lifetime.signal.reason);
  lifetime.signal.addEventListener("abort", abort, { once: true });
  if (lifetime.signal.aborted) abort();
  const scopedFetch: RequestScope["fetch"] = async (input, init) => {
    const external = requestSignal(input, init);
    // Deliberate per-fetch cancellation is terminal for this model request, never a transport retry.
    const cancel = () => lifetime.abort(external!.reason);
    external?.addEventListener("abort", cancel, { once: true });
    unlink.push(() => external?.removeEventListener("abort", cancel));
    if (external?.aborted) cancel();
    controller.signal.throwIfAborted();
    const response = await transport(input, { ...init, signal: controller.signal });
    const observed = observedResponse(response, controller.signal, activity, started, cleanups);
    if (controller.signal.aborted) {
      await Promise.all([...cleanups].map(cleanup => cleanup()));
      controller.signal.throwIfAborted();
    }
    activity();
    return observed;
  };
  return {
    scope: { signal: controller.signal, fetch: scopedFetch },
    async close() {
      lifetime.signal.removeEventListener("abort", abort);
      for (const remove of unlink) remove();
      controller.abort();
      await Promise.all([...cleanups].map(cleanup => cleanup()));
    },
  };
}
