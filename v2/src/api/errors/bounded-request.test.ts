import { afterEach, expect, spyOn, test } from "bun:test";
import { boundedModelRequest, ModelRequestError } from "./bounded-request";

let now = 0;
const timers = new Map<object, { at: number; run: () => void }>();
const spies: { mockRestore(): void }[] = [];
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
function fakeSetTimeout(handler: Bun.TimerHandler, ms?: number, ...args: unknown[]): Timer {
  const id = realSetTimeout(() => {}, 0);
  realClearTimeout(id);
  timers.set(id, { at: now + (ms ?? 0), run: () => { handler(...args); } });
  return id;
}
function fakeClearTimeout(id?: string | number | Timer | NodeJS.Timeout): void {
  if (typeof id === "object") timers.delete(id);
}
function replaceGlobal(name: string, fake: unknown, real: unknown): { mockRestore(): void } {
  Reflect.set(globalThis, name, fake);
  return { mockRestore: () => { Reflect.set(globalThis, name, real); } };
}
function clock() {
  now = 0; timers.clear();
  spies.push(replaceGlobal("setTimeout", fakeSetTimeout, realSetTimeout));
  spies.push(replaceGlobal("clearTimeout", fakeClearTimeout, realClearTimeout));
  spies.push(spyOn(Date, "now").mockImplementation(() => now));
  spies.push(spyOn(Math, "random").mockReturnValue(0.5));
}
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (next === undefined || next[1].at > end) break;
    now = next[1].at; timers.delete(next[0]); next[1].run(); await drain();
  }
  now = end; await drain();
}
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const fail = (status: number) => Object.assign(new Error("SECRET"), { status });
const result = <T>(promise: Promise<T>): Promise<unknown> => promise.then((value: unknown) => value, (error: unknown) => error);
const kindOf = (value: unknown) => value instanceof ModelRequestError ? value.kind : undefined;
const reasonOf = (value: unknown) => value instanceof ModelRequestError ? value.reason : undefined;
const messageOf = (value: unknown) => value instanceof Error ? value.message : "";

for (const headers of [false, true]) test(`${headers ? "body" : "preheaders"} stall aborts transport, no duplicate ignored executor`, async () => {
  clock(); let calls = 0; const signals: AbortSignal[] = []; let cancelled = 0;
  const pending = result(boundedModelRequest(async scope => {
    calls++; signals.push(scope.signal);
    const response = await scope.fetch("https://mock.invalid");
    await response.text(); return "done";
  }, { idleMs: 90, totalMs: 600 }, async () => headers
    ? new Response(new ReadableStream({ cancel() { cancelled++; } }))
    : new Promise<Response>(() => {})));
  await drain(); await advance(90);
  expect(kindOf(await pending)).toBe("idle-timeout"); expect(signals[0]?.aborted).toBe(true);
  expect(calls).toBe(1); expect(cancelled).toBe(headers ? 1 : 0); expect(timers.size).toBe(0);
  await advance(1000); expect(calls).toBe(1);
});

test("headers and heartbeat/reasoning/tool bytes reset idle but never absolute total", async () => {
  clock(); const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending = result(boundedModelRequest(async scope => (await scope.fetch("https://mock.invalid")).text(),
    { idleMs: 90, totalMs: 200 }, async () => {
      await new Promise(resolve => setTimeout(resolve, 70));
      return new Response(new ReadableStream<Uint8Array>({ start(c) { streams.push(c); } }));
    }));
  await advance(70);
  for (const event of [": heartbeat\n\n", "reasoning", "tool"]) {
    await advance(40); streams[0]?.enqueue(new TextEncoder().encode(event)); await drain();
  }
  await advance(10); expect(kindOf(await pending)).toBe("total-timeout"); expect(timers.size).toBe(0);
});

test("success cleans timers and caller listener", async () => {
  clock(); const caller = new AbortController();
  const add = spyOn(caller.signal, "addEventListener"); const remove = spyOn(caller.signal, "removeEventListener");
  const value = await boundedModelRequest(async scope => (await scope.fetch("https://mock.invalid")).text(),
    { signal: caller.signal }, async () => new Response("ok"));
  expect(value).toBe("ok"); expect(timers.size).toBe(0);
  expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]); add.mockRestore(); remove.mockRestore();
});

for (const mode of ["cancel", "total", "exhaust"]) test(`safe transient retries: ${mode}, sanitized lifecycle`, async () => {
  clock(); const caller = new AbortController(); let calls = 0; const events: unknown[] = [];
  const pending = result(boundedModelRequest(async () => { calls++; throw fail(503); }, {
    signal: caller.signal, totalMs: mode === "total" ? 500 : 600_000,
    onRetry: event => { events.push(event); },
  }));
  await drain();
  expect(events[0]).toEqual({ reason: "http", attempt: 2, nextRetryAt: 1000 });
  if (mode === "cancel") caller.abort("caller wins");
  await advance(mode === "exhaust" ? 15000 : 500);
  const error = await pending;
  expect(mode === "cancel" ? error : kindOf(error)).toBe(mode === "cancel" ? "caller wins" : mode === "total" ? "total-timeout" : "exhausted");
  expect(calls).toBe(mode === "exhaust" ? 4 : 1); expect(timers.size).toBe(0);
  expect(JSON.stringify(events)).not.toContain("SECRET");
});

for (const error of [fail(401), fail(400), { status: 429, error: { code: "insufficient_quota" } }]) test("quota/permanent rejection never retries", async () => {
  clock(); let calls = 0;
  const caught = await result(boundedModelRequest(async () => { calls++; const thrown: unknown = error; throw thrown; }));
  expect(caught).toBeInstanceOf(ModelRequestError); expect(messageOf(caught)).not.toContain("SECRET");
  expect(calls).toBe(1); expect(timers.size).toBe(0);
});

test("partial successful body never replays on transient failure", async () => {
  clock(); let calls = 0;
  const caught = await result(boundedModelRequest(async scope => {
    calls++; const response = await scope.fetch("https://mock.invalid");
    await response.body?.getReader().read(); throw fail(503);
  }, {}, async () => new Response("partial tool")));
  expect(kindOf(caught)).toBe("interrupted"); expect(calls).toBe(1); expect(timers.size).toBe(0);
});

test("exhausted rate limits retain the numeric HTTP status, never the provider body or a fabricated quota diagnosis", async () => {
  const error = await result(boundedModelRequest(async () => { throw fail(429); }, { backoffMs: [] }));
  expect(error).toMatchObject({ kind: "exhausted", status: 429 });
  expect(messageOf(error)).toContain("remaining account allowance is unknown");
  expect(messageOf(error)).not.toContain("SECRET");
});

test("caller cancellation wins same-turn timeout and already-aborted never executes", async () => {
  clock(); const caller = new AbortController(); let calls = 0;
  const execute = async () => { calls++; return new Promise<never>(() => {}); };
  const pending = result(boundedModelRequest(execute, { signal: caller.signal, totalMs: 1 }));
  for (const timer of [...timers.values()]) if (timer.at === 1) timer.run();
  caller.abort("caller"); expect(await pending).toBe("caller");
  expect(await result(boundedModelRequest(execute, { signal: caller.signal }))).toBe("caller");
  expect(calls).toBe(1); expect(timers.size).toBe(0);
});

 test("transport retry can succeed; throwing observer cannot alter recovery", async () => {
  clock(); let calls = 0;
  const pending = boundedModelRequest(async () => {
    if (++calls === 1) throw new Error("fetch failed SECRET"); return "ok";
  }, { onRetry: event => { expect(event.reason).toBe("transport"); throw new Error("observer"); } });
  await drain(); await advance(1000);
  expect(await pending).toBe("ok"); expect(calls).toBe(2); expect(timers.size).toBe(0);
});

for (const override of [undefined, null, "live"]) test(`Request preabort and init precedence: ${override}`, async () => {
  clock(); const request = new AbortController(); request.abort("request cancelled"); let calls = 0;
  const init = override === undefined ? undefined : { signal: override === null ? null : new AbortController().signal };
  const outcome = await result(boundedModelRequest(async scope => {
    const response = await scope.fetch(new Request("https://mock.invalid", { signal: request.signal }), init);
    return response.text();
  }, {}, async () => { calls++; return new Response("ok"); }));
  expect(outcome).toBe(override === undefined ? "request cancelled" : "ok");
  expect(calls).toBe(override === undefined ? 0 : 1); expect(timers.size).toBe(0);
});

for (const headers of [false, true]) test(`per-fetch cancel during ${headers ? "body" : "headers"} is terminal and keeps reason`, async () => {
  clock(); const caller = new AbortController(); const signals: (AbortSignal | null | undefined)[] = []; let calls = 0;
  const body = new ReadableStream<Uint8Array>();
  const pending = result(boundedModelRequest(async scope => {
    calls++; return (await scope.fetch("https://mock.invalid", { signal: caller.signal })).text();
  }, {}, async (_, init) => {
    signals.push(init?.signal);
    return headers ? new Response(body) : new Promise<Response>(() => {});
  }));
  await drain(); const reason = new DOMException("intentional", "AbortError"); caller.abort(reason);
  expect(await pending).toBe(reason); await drain();
  expect(signals[0]?.aborted).toBe(true); expect(signals[0]?.reason).toBe(reason); expect(calls).toBe(1);
  expect(body.locked).toBe(false); expect(timers.size).toBe(0);
});

test("delayed body cancellation settles before retry; each attempt HTTP is aborted", async () => {
  clock(); let calls = 0; const cancelled = Promise.withResolvers<void>(); const signals: (AbortSignal | null | undefined)[] = [];
  const body = new ReadableStream<Uint8Array>({ cancel: () => cancelled.promise });
  const pending = boundedModelRequest(async scope => {
    calls++; await scope.fetch("https://mock.invalid"); if (calls === 1) throw fail(503); return "ok";
  }, {}, async (_, init) => { signals.push(init?.signal); return new Response(calls === 1 ? body : null); });
  await drain(); expect(signals[0]?.aborted).toBe(true); expect(body.locked).toBe(true);
  await advance(2000); expect(calls).toBe(1);
  cancelled.resolve(); await drain(); expect(body.locked).toBe(false);
  await advance(1000); expect(await pending).toBe("ok"); expect(calls).toBe(2);
  expect(signals.every(signal => signal?.aborted === true)).toBe(true); expect(timers.size).toBe(0);
});

for (const end of ["total", "caller"]) test(`hung cleanup ends on ${end} without replacement`, async () => {
  clock(); const caller = new AbortController(); let calls = 0;
  const pending = result(boundedModelRequest(async scope => {
    calls++; await scope.fetch("https://mock.invalid"); throw fail(503);
  }, { totalMs: 100, signal: caller.signal }, async () => new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }))));
  await drain(); if (end === "caller") caller.abort("cancel cleanup");
  await advance(100);
  const outcome = await pending;
  expect(end === "caller" ? outcome : kindOf(outcome)).toBe(end === "caller" ? "cancel cleanup" : "total-timeout");
  expect(calls).toBe(1); expect(timers.size).toBe(0);
});

for (const mode of ["read-error", "early-return", "consumer-cancel"]) test(`reader lock released on ${mode}`, async () => {
  clock(); const signals: (AbortSignal | null | undefined)[] = [];
  const body = new ReadableStream<Uint8Array>({ start(c) { if (mode === "read-error") c.error(fail(400)); } });
  await result(boundedModelRequest(async scope => {
    const response = await scope.fetch("https://mock.invalid");
    if (mode === "read-error") await response.text();
    if (mode === "consumer-cancel") await response.body?.cancel();
  }, {}, async (_, init) => { signals.push(init?.signal); return new Response(body); }));
  expect(body.locked).toBe(false); expect(signals[0]?.aborted).toBe(true); expect(timers.size).toBe(0);
});

test("response metadata and native clone/bodyUsed semantics survive wrapping", async () => {
  clock(); const source = new Response("payload", { status: 201, statusText: "Created", headers: { "x-test": "value" } });
  Object.defineProperties(source, { url: { value: "https://mock.invalid/final" }, redirected: { value: true }, type: { value: "cors" } });
  await boundedModelRequest(async scope => {
    const response = await scope.fetch("https://mock.invalid"); const clone = response.clone();
    for (const copy of [response, clone]) {
      expect(copy.url).toBe(source.url); expect(copy.redirected).toBe(true); expect(copy.type).toBe("cors");
      expect(copy.status).toBe(201); expect(copy.statusText).toBe("Created"); expect(copy.headers.get("x-test")).toBe("value");
      expect(copy.bodyUsed).toBe(false);
    }
    expect(await response.text()).toBe("payload"); expect(response.bodyUsed).toBe(true);
    expect(() => response.clone()).toThrow(); expect(await clone.text()).toBe("payload");
  }, {}, async () => source);
  expect(source.body?.locked).toBe(false); expect(timers.size).toBe(0);
});

test("unknown failures distinguish setup, connection and response without exposing exceptions", async () => {
  const failure = new Error("SECRET");
  const before = await result(boundedModelRequest(async () => { throw failure; }));
  const execute = async (scope: Parameters<Parameters<typeof boundedModelRequest>[0]>[0]) => {
    await scope.fetch("https://mock.invalid");
    throw failure;
  };
  const transport = await result(boundedModelRequest(execute, {}, async () => { throw failure; }));
  const after = await result(boundedModelRequest(execute, {}, async () => new Response(null)));
  expect([reasonOf(before), reasonOf(transport), reasonOf(after)]).toEqual(["setup", "connection", "response"]);
  for (const error of [before, transport, after]) expect(messageOf(error)).not.toContain("SECRET");
});
