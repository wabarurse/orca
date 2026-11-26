import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { paths, readState, updateState } from "../../config";
import { codexSSE, fakeCodexTokens } from "../../test/codex";
import { anthropic } from "../anthropic";
import { CredentialError } from "../auth/oauth";
import { openai } from "../openai";
import type { CompleteRequest } from "../provider";
import { boundedModelRequest, ModelRequestError } from "./bounded-request";
import { diagnoseModelError } from "./model-diagnostics";
import type { RecoveryPolicy } from "./provider-recovery";
import { coordinatedTransport, lockoutUntil } from "./rate-limit";
import { exhaustedQuota, retryNotice, transientFailure, withTransientRetries } from "./retry";

describe("transient failures are retried, a begun stream never", () => {
  const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
  const messageOf = (value: unknown): string => value instanceof Error ? value.message : "";


  test("transientFailure: transport errors and 408/409/429/5xx/529 are transient, other 4xx and plain errors are final", () => {
    const withStatus = (status: number) => Object.assign(new Error(`${status} status`), { status });
    for (const status of [408, 409, 429, 500, 502, 503, 529]) expect(transientFailure(withStatus(status))).toBe(`HTTP ${status}`);
    for (const status of [400, 401, 403, 404, 413, 422]) expect(transientFailure(withStatus(status))).toBeUndefined();
    expect(transientFailure(Object.assign(new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true`"), { code: "ECONNRESET" }))).toBe("the socket connection was closed unexpectedly");
    expect(transientFailure(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe("connect etimedout");
    expect(transientFailure(new DOMException("The operation was aborted.", "AbortError"))).toBe("the operation was aborted");
    expect(transientFailure(Object.assign(new Error("Connection error."), { cause: Object.assign(new TypeError("fetch failed"), { code: "EPIPE" }) }))).toBe("connection error");
    expect(transientFailure(new Error("boom"))).toBeUndefined();
    expect(transientFailure(new TypeError("undefined is not a function"))).toBeUndefined();
    expect(transientFailure("string")).toBeUndefined();
  });

  test("withTransientRetries: a bounded number of retries, none after the stream started, none for a final error", async () => {
    const notices: string[] = [];
    const backoffMs = [1, 1, 1];
    let attempts = 0;
    const flaky = async () => { if (++attempts < 3) throw Object.assign(new Error("overloaded"), { status: 529 }); return "ok"; };
    expect(await withTransientRetries(flaky, { backoffMs, notice: t => notices.push(t), what: "fake" })).toBe("ok");
    expect(attempts).toBe(3);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toBe(retryNotice("fake", "HTTP 529", 1, 1, 3));
    expect(notices[0]).toBe("fake request failed (HTTP 529); retrying in 0.00s (1/3)");
    expect(retryNotice("claude", "HTTP 529", 4200, 2, 3)).toBe("claude request failed (HTTP 529); retrying in 4s (2/3)");
    attempts = 0;
    await expect(withTransientRetries(async () => { attempts++; throw Object.assign(new Error("down"), { status: 503 }); }, { backoffMs, notice() {} })).rejects.toThrow("down");
    expect(attempts).toBe(4);
    attempts = 0;
    await expect(withTransientRetries(async started => { attempts++; started(); throw Object.assign(new Error("mid-stream"), { code: "ECONNRESET" }); }, { backoffMs, notice() {} })).rejects.toThrow("mid-stream");
    expect(attempts).toBe(1);
    attempts = 0;
    await expect(withTransientRetries(async () => { attempts++; throw Object.assign(new Error("bad request"), { status: 400 }); }, { backoffMs, notice() {} })).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  test("withTransientRetries: an abort mid-backoff throws the abort reason at once; an aborted signal never starts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by user");
    let attempts = 0;
    const seen = { notice: false };
    const result = withTransientRetries(async () => { attempts++; throw Object.assign(new Error("down"), { status: 503 }); },
      { backoffMs: [60_000], signal: controller.signal, notice: () => { seen.notice = true; } });
    while (!seen.notice) await Bun.sleep(1);
    controller.abort(reason);
    expect(await caught(result)).toBe(reason);
    expect(attempts).toBe(1);
    await expect(withTransientRetries(async () => { attempts++; return 1; }, { signal: controller.signal })).rejects.toBe(reason);
    expect(attempts).toBe(1);
    const late = new AbortController();
    await expect(withTransientRetries(async () => { attempts++; late.abort(reason); throw Object.assign(new Error("closed"), { code: "ECONNRESET" }); }, { signal: late.signal, backoffMs: [1] })).rejects.toBe(reason);
    expect(attempts).toBe(2);
  });


  const claudeEvents = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const sse = (events: { type: string }[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const claudeRequest = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({ model: "claude-test", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, onText() {}, ...extra });

  async function claudeServer(respond: (n: number, request: Request) => Response | Promise<Response>) {
    let requests = 0;
    const server = Bun.serve({ port: 0, fetch: request => respond(++requests, request) });
    const client = new Anthropic({ apiKey: "test-only", baseURL: server.url.toString() });
    return { client, requests: () => requests, stop: () => server.stop(true) };
  }

  test("Claude: overloaded answers are retried by one harness budget until one streams", async () => {
    const s = await claudeServer(n => n <= 2 ? Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 })
      : new Response(sse(claudeEvents), { headers: { "content-type": "text/event-stream" } }));
    try {
      const notices: string[] = []; let text = "";
      const turn = await anthropic(s.client, { retry: { backoffMs: [1, 1, 1] } }).complete(claudeRequest({ onText: t => { text += t; }, onNotice: t => notices.push(t) }));
      expect(turn.stop).toBe("end"); expect(text).toBe("hello");
      expect(s.requests()).toBe(3);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toContain("(1/3)"); expect(notices[1]).toContain("(2/3)");
    } finally { await s.stop(); }
  });

  test("Claude: a 400 is not retried", async () => {
    const s = await claudeServer(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, { status: 400 }));
    try {
      const notices: string[] = [];
      await expect(anthropic(s.client, { retry: { backoffMs: [1, 1, 1] } }).complete(claudeRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow(/400/);
      expect(s.requests()).toBe(1); expect(notices).toEqual([]);
    } finally { await s.stop(); }
  });

  test("Claude: a cancel during the backoff rejects with the cancellation at once, with no further request", async () => {
    const s = await claudeServer(() => Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: 503 }));
    try {
      const controller = new AbortController(), reason = new Error("cancelled by user");
      const seen = { notice: false };
      const result = anthropic(s.client, { retry: { backoffMs: [60_000] } }).complete(claudeRequest({ signal: controller.signal, onNotice: () => { seen.notice = true; } }));
      while (!seen.notice) await Bun.sleep(1);
      controller.abort(reason);
      expect(await caught(result)).toBe(reason);
      expect(s.requests()).toBe(1);
    } finally { await s.stop(); }
  });

  test("Claude: a stream that fails after its first event is not retried", async () => {
    const s = await claudeServer(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(claudeEvents.slice(0, 3))));
      setTimeout(() => controller.close(), 5);
    } }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const notices: string[] = [];
      await expect(anthropic(s.client, { retry: { backoffMs: [1, 1, 1] } }).complete(claudeRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow();
      expect(s.requests()).toBe(1); expect(notices).toEqual([]);
    } finally { await s.stop(); }
  });


  let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; });
  function intercept(respond: (n: number, request: Request) => Promise<Response>) {
    let requests = 0;
    mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        respond(++requests, input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
      { preconnect: fetch.preconnect },
    ));
    return () => requests;
  }
  const codexMessage = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] };
  const codexRequest = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({ model: "gpt-test", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, onText() {}, ...extra });

  test("Codex: a closed socket on the first request is retried and the second streams; the retry is a transcript note", async () => {
    const requests = intercept(async n => {
      if (n === 1) throw Object.assign(new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"), { code: "ECONNRESET" });
      return codexSSE([{ type: "response.output_text.delta", delta: "hello" }, { type: "response.completed", response: { status: "completed", output: [codexMessage] } }]);
    });
    const notices: string[] = []; let text = "";
    const turn = await openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onText: t => { text += t; }, onNotice: t => notices.push(t) }));
    expect(turn.stop).toBe("end"); expect(text).toBe("hello");
    expect(requests()).toBe(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^codex request failed \(connection error\); retrying in \d\.\d\ds \(1\/3\)$/);
  });

  test("Codex: a 500 is retried up to the bound, then fails; a 400 is not retried", async () => {
    let requests = intercept(async () => Response.json({ error: { message: "down" } }, { status: 500 }));
    const notices: string[] = [];
    await expect(openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow(/500/);
    expect(requests()).toBe(4); expect(notices).toHaveLength(3);
    mockFetch?.mockRestore();
    requests = intercept(async () => Response.json({ error: { message: "bad request" } }, { status: 400 }));
    await expect(openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow(/400/);
    expect(requests()).toBe(1); expect(notices).toHaveLength(3);
  });

  test("Codex: a cancel during the backoff rejects with the cancellation at once, with no further request", async () => {
    const requests = intercept(async () => Response.json({ error: { message: "down" } }, { status: 503 }));
    const controller = new AbortController(), reason = new Error("cancelled by user");
    const seen = { notice: false };
    const result = openai(async () => fakeCodexTokens(), { retry: { backoffMs: [60_000] } }).complete(codexRequest({ signal: controller.signal, onNotice: () => { seen.notice = true; } }));
    while (!seen.notice) await Bun.sleep(1);
    controller.abort(reason);
    expect(await caught(result)).toBe(reason);
    expect(requests()).toBe(1);
  });

  test("Codex: a stream that fails after its first event is not retried", async () => {
    const requests = intercept(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      setTimeout(() => controller.error(new Error("socket closed")), 5);
    } }), { headers: { "content-type": "text/event-stream" } }));
    const notices: string[] = [];
    await expect(openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow();
    expect(requests()).toBe(1); expect(notices).toEqual([]);
  });


  for (const code of ["insufficient_quota", "usage_limit_reached", "billing_hard_limit_reached"]) {
    test(`Codex: structured ${code} is persistent with model, no retry or raw secrets`, async () => {
      const requests = intercept(async () => Response.json({ error: { code, message: "Bearer SECRET\u001b[31m", resets_at: 2000000000 } }, { status: 429 }));
      const notices: string[] = [];
      const error = await caught(openai(async () => fakeCodexTokens()).complete(codexRequest({ onNotice: t => notices.push(t) })));
      expect(messageOf(error)).toContain("codex (gpt-test): quota exhausted");
      expect(messageOf(error)).toContain("Reset: 2033-05-18T03:33:20.000Z");
      expect(messageOf(error)).not.toContain("SECRET");
      expect(requests()).toBe(1); expect(notices).toEqual([]);
    });
  }

  test("Codex: ordinary 429 retries and succeeds, even with quota words in its message", async () => {
    const requests = intercept(async n => n === 1
      ? Response.json({ error: { code: "rate_limit_exceeded", message: "quota" } }, { status: 429 })
      : codexSSE([{ type: "response.completed", response: { status: "completed", output: [codexMessage] } }]));
    await openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1] } }).complete(codexRequest({ onNotice() {} }));
    expect(requests()).toBe(2);
  });

  for (const event of [
    { type: "error", code: "usage_limit_reached", message: "SECRET" },
    { type: "response.failed", response: { error: { code: "insufficient_quota", message: "SECRET" } } },
  ]) test(`Codex: ${event.type} retains structured quota evidence after partial output`, async () => {
    const requests = intercept(async () => codexSSE([{ type: "response.output_text.delta", delta: "partial" }, event]));
    let text = "";
    await expect(openai(async () => fakeCodexTokens()).complete(codexRequest({ onText: t => { text += t; } })))
      .rejects.toThrow("codex (gpt-test): quota exhausted");
    expect(text).toBe("partial"); expect(requests()).toBe(1);
  });

  for (const streaming of [false, true]) test(`Claude: quota ${streaming ? "stream event" : "HTTP 429"} is not retried by either layer`, async () => {
    const body = { type: "error", error: { type: "usage_limit_reached", message: "SECRET" } };
    const s = await claudeServer(() => streaming
      ? new Response(sse([body]), { headers: { "content-type": "text/event-stream" } })
      : Response.json(body, { status: 429 }));
    try {
      const notices: string[] = [];
      const error = await caught(anthropic(s.client).complete(claudeRequest({ onNotice: t => notices.push(t) })));
      expect(messageOf(error)).toContain("claude (claude-test): quota exhausted");
      expect(messageOf(error)).not.toContain("Reset:"); expect(messageOf(error)).not.toContain("SECRET");
      expect(s.requests()).toBe(1); expect(notices).toEqual([]);
    } finally { await s.stop(); }
  });

  test("quota evidence: Anthropic credits, no generic rate-limit, timeouts, sockets or invented resets", () => {
    expect(exhaustedQuota({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })).toContain("insufficient credits");
    for (const error of [{ status: 429 }, { error: { type: "rate_limit_error", message: "quota exhausted" } }, new Error("quota exhausted"), { code: "ETIMEDOUT" }, { code: "ECONNRESET" }])
      expect(exhaustedQuota(error)).toBeUndefined();
    expect(exhaustedQuota({ code: "usage_limit_reached", resets_at: "tomorrow SECRET" })).not.toContain("Reset:");
  });
});

describe("request deadlines", () => {
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
});

describe("429 cooldown", () => {
  const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
  const messageOf = (value: unknown): string => value instanceof Error ? value.message : "";
  const root = mkdtempSync(join(tmpdir(), "orca-rate-limit-"));
  let previousHome: string | undefined;
  beforeAll(() => { previousHome = process.env.ORCA2_HOME; process.env.ORCA2_HOME = root; });
  afterAll(() => { if (previousHome === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = previousHome; rmSync(root, { recursive: true, force: true }); });
  test("a 429 delays another instance of the same account, without blocking another account", async () => {
    await coordinatedTransport("a", async () => new Response(null, { status: 429, headers: { "retry-after": "0.06" } }))("https://example.test");
    let called = false;
    const waiting = coordinatedTransport("a", async () => { called = true; return new Response("ok"); })("https://example.test");
    await coordinatedTransport("b", async () => new Response("ok"))("https://example.test");
    expect(called).toBe(false);
    await waiting; expect(called).toBe(true);
  });
  test("cancellation stops admission before making another HTTP request", async () => {
    await coordinatedTransport("cancel", async () => new Response(null, { status: 429, headers: { "retry-after": "5" } }))("https://example.test");
    const controller = new AbortController(); let calls = 0;
    const pending = coordinatedTransport("cancel", async () => { calls++; return new Response(); })("https://example.test", { signal: controller.signal });
    controller.abort(Error("user stopped"));
    await expect(pending).rejects.toThrow("user stopped"); expect(calls).toBe(0);
  });
  const locked = () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, { status: 429, headers: { "retry-after": "3600" } });
  test("a lockout is never saved or waited for: every request asks the provider", async () => {
    let calls = 0;
    const ask = coordinatedTransport("long", async () => { calls++; return locked(); });
    for (let i = 0; i < 3; i++) expect((await ask("https://example.test")).status).toBe(429);
    expect(calls).toBe(3);
    expect((await coordinatedTransport("long", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
  });
  test("a lockout saved by an older build is asked about, and a success clears it", async () => {
    const saved = () => readState(paths.memory, z.unknown(), "provider-rate:old", "cooldown");
    updateState(paths.memory, z.unknown(), "provider-rate:old", "cooldown", () => ({ until: Date.now() + 3600_000, probeAt: Date.now() + 3600_000, failures: 1, version: "v" }));
    expect((await coordinatedTransport("old", async () => locked())("https://example.test")).status).toBe(429);
    expect(saved()).toBeDefined();
    expect((await coordinatedTransport("old", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
    expect(saved()).toBeUndefined();
  });
  test("a lockout is one request, reported as a rate limit with its end time", async () => {
    expect(lockoutUntil(new Response(null, { status: 429, headers: { "retry-after": "30" } }))).toBeUndefined();
    expect(lockoutUntil({ status: 429, headers: { "retry-after": "3600" } }, 1000)).toBe(3601000);
    expect(lockoutUntil({ status: 500, headers: { "retry-after": "3600" } })).toBeUndefined();
    let calls = 0;
    const transport = Object.assign(async () => { calls++; return locked(); }, { preconnect: fetch.preconnect });
    const provider = anthropic(new Anthropic({ apiKey: "test", fetch: transport }), { recovery: { enabled: true, account: "report", idleMs: 100, totalMs: 2000 }, retry: { backoffMs: [0, 0] } });
    const request: CompleteRequest = { model: "test", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100, onText() {} };
    const error = await caught(provider.complete(request));
    expect(error).toMatchObject({ reason: "rate-limit", status: 429 });
    expect(messageOf(error)).toMatch(/^The provider rate limited this account until \w{3} \d+\D+\d+:\d\d [AP]M\. Switch accounts/);
    expect(calls).toBe(1);
  });
  test("a cooldown published by another agent process is shared without sharing profiles", async () => {
    const script = `import { coordinatedTransport } from ${JSON.stringify(import.meta.dir + "/rate-limit.ts")}; await coordinatedTransport('cross-process', async () => new Response(null, {status:429,headers:{'retry-after':'0.5'}}))('https://example.test');`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ORCA2_HOME: root }, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    let called = false;
    const waiting = coordinatedTransport("cross-process", async () => { called = true; return new Response("ok"); })("https://example.test");
    expect((await coordinatedTransport("other-profile", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
    expect(called).toBe(false);
    expect((await waiting).ok).toBe(true);
  });
});

describe("provider recovery", () => {
  const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
  const messageOf = (value: unknown): string => value instanceof Error ? value.message : "";

  let mock: { mockRestore(): void } | undefined;
  afterEach(() => { mock?.mockRestore(); });
  const encoder = new TextEncoder();
  const req: CompleteRequest = { model: "test", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100, onText() {} };
  const policy: RecoveryPolicy = { enabled: true, idleMs: 100, totalMs: 1000 };
  const claudeEvents = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const sse = (events: typeof claudeEvents) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  for (const name of ["claude", "codex"]) {
    const success = () => name === "claude" ? new Response(sse(claudeEvents), { headers: { "content-type": "text/event-stream" } }) : codexSSE([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    const make = (transport: typeof fetch, recovery: RecoveryPolicy | undefined = policy) => {
      if (name === "claude") return anthropic(new Anthropic({ apiKey: "test", fetch: transport }), { recovery, retry: { backoffMs: [0, 0] } });
      mock = spyOn(globalThis, "fetch").mockImplementation(transport);
      return openai(async () => fakeCodexTokens(), { recovery, retry: { backoffMs: [0, 0] } });
    };
    const fetcher = (fn: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) => Object.assign(fn, { preconnect: fetch.preconnect });
    test(`${name}: normal completion and caller signal scoped to HTTP`, async () => {
      const caller = new AbortController();
      let signal: AbortSignal | null | undefined;
      const provider = make(fetcher(async (_, init) => { signal = init?.signal; return success(); }));
      expect((await provider.complete({ ...req, signal: caller.signal })).stop).toBe("end");
      expect(signal).toBeDefined();
      expect(signal).not.toBe(caller.signal);
      expect(caller.signal.aborted).toBe(false);
    });
    test(`${name}: exactly three transient attempts with safe notices`, async () => {
      let calls = 0;
      const notices: string[] = [];
      const events: unknown[] = [];
      const provider = make(fetcher(async () => { calls++; return Response.json({ error: { message: "SECRET", type: "server_error" } }, { status: 503 }); }), { ...policy, onRetry: e => events.push(e) });
      await expect(provider.complete({ ...req, onNotice: n => notices.push(n) })).rejects.toMatchObject({ kind: "exhausted", reason: "provider-service", status: 503 });
      expect(calls).toBe(3);
      expect(events).toHaveLength(2);
      expect(notices).toHaveLength(2);
      expect(notices.join()).not.toContain("SECRET");
      expect(notices[0]).toContain("attempt 2, nextRetryAt");
    });
    test(`${name}: transport failures have no nested SDK retries`, async () => {
      let calls = 0;
      const provider = make(fetcher(async () => { calls++; throw new TypeError("fetch failed"); }));
      await expect(provider.complete(req)).rejects.toMatchObject({ kind: "exhausted", reason: "connection" });
      expect(calls).toBe(3);
    });
    test(`${name}: quota is terminal`, async () => {
      let calls = 0;
      const provider = make(fetcher(async () => { calls++; return Response.json({ error: { type: "insufficient_quota" } }, { status: 429 }); }));
      await expect(provider.complete(req)).rejects.toMatchObject({ kind: "quota", reason: "quota", status: 429 });
      expect(calls).toBe(1);
    });
    const statusReasons: [number, string][] = [[403, "permission"], [404, "model-unavailable"], [413, "input-too-large"], [429, "rate-limit"]];
    for (const [status, reason] of statusReasons) {
      test(`${name}: diagnoses HTTP ${status} without exposing the response body`, async () => {
        const provider = make(fetcher(async () => Response.json({ error: { message: "SECRET" } }, { status })));
        const error = await caught(provider.complete(req));
        expect(error).toMatchObject({ status, reason });
        expect(messageOf(error)).not.toContain("SECRET");
      });
    }
    test(`${name}: reports rejected credential exchange separately from model HTTP errors`, async () => {
      const credentials = async () => { throw new CredentialError("oauth-http", "SECRET", 400); };
      const transport = fetcher(async () => { throw new Error("model request should not be sent"); });
      const provider = name === "claude"
        ? anthropic(new Anthropic({ apiKey: null, authToken: null, credentials, fetch: transport }), { recovery: policy })
        : openai(credentials, { recovery: policy });
      const error = await caught(provider.complete(req));
      expect(error).toMatchObject({ kind: "permanent", reason: "oauth-http", oauthStatus: 400 });
      expect(error instanceof ModelRequestError && error.status === undefined).toBe(true);
      expect(messageOf(error)).not.toContain("SECRET");
    });
    for (const stage of ["headers", "body", "partial"]) test(`${name}: stalled ${stage} is terminal, no replay`, async () => {
      let calls = 0;
      let signal: AbortSignal | null | undefined;
      const provider = make(fetcher(async (_, init) => {
        calls++; signal = init?.signal;
        if (stage === "headers") return new Promise(() => {});
        return new Response(new ReadableStream({ start(c) {
          if (stage === "partial") c.enqueue(encoder.encode(name === "claude" ? sse(claudeEvents.slice(0, 1)) : 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        } }), { headers: { "content-type": "text/event-stream" } });
      }));
      await expect(provider.complete(req)).rejects.toMatchObject({ kind: "idle-timeout" });
      expect(calls).toBe(1); expect(signal?.aborted).toBe(true);
    });
    test(`${name}: successful body bytes forbid replay on disconnect`, async () => {
      let calls = 0, pulls = 0;
      const provider = make(fetcher(async () => {
        calls++;
        return new Response(new ReadableStream({ pull(c) {
          if (pulls++ > 0) c.error(new TypeError("network disconnected"));
          else c.enqueue(encoder.encode(name === "claude" ? sse(claudeEvents.slice(0, 1)) : 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        } }), { headers: { "content-type": "text/event-stream", "request-id": "safe-test-id" } });
      }));
      await expect(provider.complete(req)).rejects.toMatchObject({ kind: "interrupted" });
      expect(calls).toBe(1);
    });
    test(`${name}: total deadline includes retry backoff`, async () => {
      let calls = 0;
      const transport = fetcher(async () => { calls++; return Response.json({}, { status: 503 }); });
      make(transport);
      const recovery = { ...policy, totalMs: 20 };
      const provider = name === "claude" ? anthropic(new Anthropic({ apiKey: "test", fetch: transport }), { recovery, retry: { backoffMs: [200] } }) : openai(async () => fakeCodexTokens(), { recovery, retry: { backoffMs: [200] } });
      await expect(provider.complete(req)).rejects.toMatchObject({ kind: "total-timeout" });
      expect(calls).toBe(1);
    });
    test(`${name}: caller cancellation never retries`, async () => {
      let calls = 0;
      const caller = new AbortController();
      const reason = new Error("caller stopped");
      const provider = make(fetcher(async () => { calls++; caller.abort(reason); return success(); }));
      await expect(provider.complete({ ...req, signal: caller.signal })).rejects.toBe(reason);
      expect(calls).toBe(1);
    });
    test(`${name}: constructor defaults leave bounded recovery off`, async () => {
      make(fetcher(async () => Response.json({ error: { type: "invalid_request_error" } }, { status: 400 })), undefined);
      const actual = name === "claude" ? anthropic(new Anthropic({ apiKey: "test", fetch: fetcher(async () => Response.json({}, { status: 400 })) })) : openai(async () => fakeCodexTokens());
      await expect(actual.complete(req)).rejects.not.toHaveProperty("kind");
    });
  }

  test("Claude: SDK zero retries still refreshes credentials once after 401", async () => {
    let calls = 0;
    const refresh: (boolean | undefined)[] = [];
    const client = new Anthropic({ apiKey: null, authToken: null,
      credentials: async opts => { refresh.push(opts?.forceRefresh); return { token: `token-${refresh.length}`, expiresAt: Date.now() / 1000 + 3600 }; },
      fetch: async () => { calls++; return Response.json({ error: { type: "authentication_error" } }, { status: 401 }); },
    });
    await expect(anthropic(client, { recovery: policy }).complete(req)).rejects.toMatchObject({ kind: "permanent", reason: "authentication", status: 401 });
    expect(calls).toBe(2); expect(refresh).toEqual([undefined, true]);
  });

  test("Claude: refreshed request completes and metadata reaches SDK middleware", async () => {
    let calls = 0;
    const seen: string[] = [];
    const client = new Anthropic({ apiKey: null, authToken: null,
      credentials: async () => ({ token: "test", expiresAt: Date.now() / 1000 + 3600 }),
      middleware: [async (request, next) => {
        const response = await next(request);
        seen.push(`${response.status}:${response.headers.get("request-id")}:${response.url}`);
        return response;
      }],
      fetch: async () => {
        const response = ++calls === 1 ? Response.json({}, { status: 401 }) : new Response(sse(claudeEvents));
        response.headers.set("request-id", "test-id");
        Object.defineProperty(response, "url", { value: "https://example.test/messages" });
        return response;
      },
    });
    expect((await anthropic(client, { recovery: policy }).complete(req)).stop).toBe("end");
    expect(calls).toBe(2);
    expect(seen).toEqual(["401:test-id:https://example.test/messages", "200:test-id:https://example.test/messages"]);
  });

  const refreshScenarios = [
    { outcome: "success", statuses: [401, 200], flags: [undefined, true] },
    { outcome: "rejected", statuses: [401, 401], flags: [undefined, true] },
    { outcome: "transient", statuses: [401, 503, 401], flags: [undefined, true, undefined] },
    { outcome: "cancelled", statuses: [401], flags: [undefined, true] },
  ];
  async function expectRefreshResult(result: ReturnType<ReturnType<typeof openai>["complete"]>, outcome: string, reason: Error) {
    if (outcome === "success") expect((await result).stop).toBe("end");
    else if (outcome === "cancelled") await expect(result).rejects.toBe(reason);
    else await expect(result).rejects.toMatchObject({ kind: "permanent", reason: "authentication", status: 401 });
  }
  for (const { outcome, statuses, flags } of refreshScenarios) test(`Codex opt-in 401 refresh: ${outcome}`, async () => {
    let calls = 0;
    const refresh: (boolean | undefined)[] = [];
    const authorization: (string | null)[] = [];
    const caller = new AbortController();
    const reason = new Error("stopped during refresh");
    const initial = fakeCodexTokens("test-account", Date.now() + 3600_000, "initial");
    const renewed = fakeCodexTokens("test-account", Date.now() + 3600_000, "renewed");
    mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      authorization.push(request.headers.get("authorization"));
      if (statuses[calls - 1] === 200) return codexSSE([{ type: "response.completed", response: { status: "completed", output: [] } }]);
      return Response.json({ error: { type: "authentication_error" } }, { status: statuses[calls - 1] ?? 200 });
    }, { preconnect: fetch.preconnect }));
    const provider = openai(async opts => {
      refresh.push(opts?.forceRefresh);
      if (opts?.forceRefresh === true && outcome === "cancelled") caller.abort(reason);
      return opts?.forceRefresh === true || refresh.length > 1 ? renewed : initial;
    }, { recovery: policy, retry: { backoffMs: [0, 0] } });
    const result = provider.complete({ ...req, signal: caller.signal });
    await expectRefreshResult(result, outcome, reason);
    expect(calls).toBe(statuses.length);
    expect(refresh).toEqual([...flags]);
    expect(authorization).toEqual([`Bearer ${initial.accessToken}`, ...Array.from({ length: calls - 1 }, () => `Bearer ${renewed.accessToken}`)]);
  });

  test("Codex keeps structured diagnostics when the response fails during streaming", async () => {
    let calls = 0;
    mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++;
      return codexSSE([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "response.failed", response: { error: { code: "server_error", message: "SECRET" } } },
      ]);
    }, { preconnect: fetch.preconnect }));
    const provider = openai(async () => fakeCodexTokens(), { recovery: policy, retry: { backoffMs: [0, 0] } });
    const error = await caught(provider.complete(req));
    expect(error).toMatchObject({ kind: "interrupted", reason: "provider-service" });
    expect(messageOf(error)).not.toContain("SECRET");
    expect(calls).toBe(1);
  });
});

describe("what the user reads about a failure", () => {
  test("many-image rejection explains recovery without leaking the provider payload", () => {
    const error = diagnoseModelError({ status: 400, error: { type: "invalid_request_error",
      message: "messages.12.content.0.image: For many-image requests, each image dimension must be <= 3000 pixels. PRIVATE" } });
    expect(error.reason).toBe("image-limit");
    expect(error.message).toContain("/compact");
    expect(error.message).not.toContain("PRIVATE");
    expect(error.kind).toBe("permanent");
    expect(diagnoseModelError({ status: 400, error: { type: "invalid_request_error", message: "Invalid tool schema" } }).reason).toBe("invalid-request");
  });
});

describe("cancelling a request", () => {
  test("Claude cancellation disconnects an in-progress HTTP stream", async () => {
    const stream = { disconnected: false };
    const events = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    ];
    const server = Bun.serve({ port: 0, fetch() {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
      }, cancel() { stream.disconnected = true; } }), { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const abort = new AbortController();
      const provider = anthropic(new Anthropic({ apiKey: "test-only", baseURL: server.url.toString(), maxRetries: 0 }));
      const result = provider.complete({ model: "claude-test", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, signal: abort.signal,
        onText() { abort.abort(); },
      });
      await expect(result).rejects.toThrow();
      const deadline = Date.now() + 2000;
      while (!stream.disconnected && Date.now() < deadline) await Bun.sleep(5);
      expect(stream.disconnected).toBe(true);
    } finally { await server.stop(true); }
  });
});
