export type RequestScope = { signal: AbortSignal; fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> };
type Cleanup = () => Promise<void>;

function responseMetadata(response: Response, source: Response): Response {
  const clone = response.clone.bind(response);
  const copy = (): Response => {
    const cloned: unknown = clone();
    if (!(cloned instanceof Response)) throw new TypeError("response clone is not a Response");
    return responseMetadata(cloned, source);
  };
  Object.defineProperties(response, {
    url: { value: source.url }, redirected: { value: source.redirected }, type: { value: source.type },
    clone: { value: copy },
  });
  return response;
}

function observedResponse(source: Response, signal: AbortSignal, activity: () => void, started: () => void, cleanups: Set<Cleanup>): Response {
  if (source.body === null) return source;
  const reader = source.body.getReader();
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    try { await reader.cancel(); } catch {}
    finally { reader.releaseLock(); cleanups.delete(cleanup); signal.removeEventListener("abort", abort); }
  })();
  const abort = () => { void cleanup().catch(() => {}); };
  cleanups.add(cleanup);
  signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) { await cleanup(); output.close(); return; }
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new TypeError("response body chunk is not bytes");
        if (value.byteLength > 0) { if (source.ok) started(); activity(); }
        output.enqueue(value);
      } catch (error) { output.error(error); await cleanup(); }
    },
    cancel: cleanup,
  }, { highWaterMark: 0 });
  return responseMetadata(new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers }), source);
}

function requestSignal(input: Parameters<typeof fetch>[0], init?: RequestInit): AbortSignal | undefined {
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
    const cancel = () => lifetime.abort(external?.reason);
    external?.addEventListener("abort", cancel, { once: true });
    unlink.push(() => external?.removeEventListener("abort", cancel));
    if (external?.aborted === true) cancel();
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
