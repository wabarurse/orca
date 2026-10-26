import { afterEach, expect, spyOn, test } from "bun:test";
import { boundedModelRequest, ModelRequestError } from "./bounded-request";

// Virtual timers, no network or wall-clock sleeps. Drain async stream/promise continuations.
let now = 0;
let sequence = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const spies: { mockRestore(): void }[] = [];
function clock() {
  now = 0; timers.clear();
  spies.push(spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
    const id = ++sequence; timers.set(id, { at: now + ms, run }); return id;
  }) as typeof setTimeout));
  spies.push(spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { timers.delete(id); }) as typeof clearTimeout));
  spies.push(spyOn(Date, "now").mockImplementation(() => now));
  spies.push(spyOn(Math, "random").mockReturnValue(0.5));
}
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function advance(ms: number) {
  const end = now + ms;
  while (true) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > end) break;
    now = next[1].at; timers.delete(next[0]); next[1].run(); await drain();
  }
  now = end; await drain();
}
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const fail = (status: number) => Object.assign(new Error("SECRET"), { status });
const result = <T>(promise: Promise<T>) => promise.catch(error => error);

for (const headers of [false, true]) test(`${headers ? "body" : "preheaders"} stall aborts transport, no duplicate ignored executor`, async () => {
  clock(); let calls = 0; let signal!: AbortSignal; let cancelled = 0;
  const pending = result(boundedModelRequest(async scope => {
    calls++; signal = scope.signal;
    const response = await scope.fetch("https://mock.invalid");
    await response.text(); return "done";
  }, { idleMs: 90, totalMs: 600 }, async () => headers
    ? new Response(new ReadableStream({ cancel() { cancelled++; } }))
    : new Promise<Response>(() => {})));
  await drain(); await advance(90);
  expect((await pending).kind).toBe("idle-timeout"); expect(signal.aborted).toBe(true);
  expect(calls).toBe(1); expect(cancelled).toBe(headers ? 1 : 0); expect(timers.size).toBe(0);
  await advance(1000); expect(calls).toBe(1);
});

test("headers and heartbeat/reasoning/tool bytes reset idle but never absolute total", async () => {
  clock(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  const pending = result(boundedModelRequest(async scope => (await scope.fetch("https://mock.invalid")).text(),
    { idleMs: 90, totalMs: 200 }, async () => {
      await new Promise(resolve => setTimeout(resolve, 70));
      return new Response(new ReadableStream({ start(c) { stream = c; } }));
    }));
  await advance(70);
  for (const event of [": heartbeat\n\n", "reasoning", "tool"]) {
    await advance(40); stream.enqueue(new TextEncoder().encode(event)); await drain();
  }
  await advance(10); expect((await pending).kind).toBe("total-timeout"); expect(timers.size).toBe(0);
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
  expect(mode === "cancel" ? error : error.kind).toBe(mode === "cancel" ? "caller wins" : mode === "total" ? "total-timeout" : "exhausted");
  expect(calls).toBe(mode === "exhaust" ? 4 : 1); expect(timers.size).toBe(0);
  expect(JSON.stringify(events)).not.toContain("SECRET");
});

for (const error of [fail(401), fail(400), { status: 429, error: { code: "insufficient_quota" } }]) test("quota/permanent rejection never retries", async () => {
  clock(); let calls = 0;
  const caught = await result(boundedModelRequest(async () => { calls++; throw error; }));
  expect(caught).toBeInstanceOf(ModelRequestError); expect(caught.message).not.toContain("SECRET");
  expect(calls).toBe(1); expect(timers.size).toBe(0);
});

test("partial successful body never replays on transient failure", async () => {
  clock(); let calls = 0;
  const caught = await result(boundedModelRequest(async scope => {
    calls++; const response = await scope.fetch("https://mock.invalid");
    await response.body!.getReader().read(); throw fail(503);
  }, {}, async () => new Response("partial tool")));
  expect(caught.kind).toBe("interrupted"); expect(calls).toBe(1); expect(timers.size).toBe(0);
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
