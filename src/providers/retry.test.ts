import { afterEach, expect, spyOn, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { retryNotice, transientFailure, withTransientRetries } from "./retry";
import type { CompleteRequest } from "./provider";
import { codexSSE, fakeCodexTokens } from "../test/codex";

// ---- the helper ----

test("transientFailure: transport errors and 408/409/429/5xx/529 are transient, other 4xx and plain errors are final", () => {
  const withStatus = (status: number) => Object.assign(new Error(`${status} status`), { status });
  for (const status of [408, 409, 429, 500, 502, 503, 529]) expect(transientFailure(withStatus(status))).toBe(`HTTP ${status}`);
  for (const status of [400, 401, 403, 404, 413, 422]) expect(transientFailure(withStatus(status))).toBeUndefined();
  expect(transientFailure(Object.assign(new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true`"), { code: "ECONNRESET" }))).toBe("the socket connection was closed unexpectedly");
  expect(transientFailure(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe("connect etimedout");
  expect(transientFailure(new DOMException("The operation was aborted.", "AbortError"))).toBe("the operation was aborted");
  // The SDKs wrap the transport error: it is found through the cause chain.
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
  expect(notices[0]).toBe(retryNotice("fake", "HTTP 529", 1, 1, 3)); // a 1ms backoff jitters to 1ms
  expect(notices[0]).toBe("fake request failed (HTTP 529); retrying in 0.00s (1/3)");
  expect(retryNotice("claude", "HTTP 529", 4200, 2, 3)).toBe("claude request failed (HTTP 529); retrying in 4s (2/3)");
  attempts = 0;
  await expect(withTransientRetries(async () => { attempts++; throw Object.assign(new Error("down"), { status: 503 }); }, { backoffMs, notice() {} })).rejects.toThrow("down");
  expect(attempts).toBe(4); // the request plus every retry
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
  let attempts = 0, noticed = false;
  const result = withTransientRetries(async () => { attempts++; throw Object.assign(new Error("down"), { status: 503 }); },
    { backoffMs: [60_000], signal: controller.signal, notice: () => { noticed = true; } });
  while (!noticed) await Bun.sleep(1);
  controller.abort(reason);
  expect(await result.catch(e => e)).toBe(reason);
  expect(attempts).toBe(1);
  await expect(withTransientRetries(async () => { attempts++; return 1; }, { signal: controller.signal })).rejects.toBe(reason);
  expect(attempts).toBe(1);
  // A request that fails because our signal aborted is not a transient failure either.
  const late = new AbortController();
  await expect(withTransientRetries(async () => { attempts++; late.abort(reason); throw Object.assign(new Error("closed"), { code: "ECONNRESET" }); }, { signal: late.signal, backoffMs: [1] })).rejects.toBe(reason);
  expect(attempts).toBe(2);
});

// ---- the Claude client, over the real SDK against a local server ----

const claudeEvents = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const claudeRequest = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({ model: "claude-test", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, onText() {}, ...extra });

async function claudeServer(respond: (n: number, request: Request) => Response | Promise<Response>) {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: request => respond(++requests, request) });
  const client = new Anthropic({ apiKey: "test-only", baseURL: server.url.toString() });
  return { client, requests: () => requests, stop: () => server.stop(true) };
}

// The SDK keeps one retry of its own (its 401 credentials refresh needs it), silent and first; ours follow it.
test("Claude: overloaded answers are retried (the SDK's one, then ours, as a transcript note) until one streams", async () => {
  const s = await claudeServer(n => n <= 2 ? Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 })
    : new Response(sse(claudeEvents), { headers: { "content-type": "text/event-stream" } }));
  try {
    const notices: string[] = []; let text = "";
    const turn = await anthropic(s.client, { retry: { backoffMs: [1, 1, 1] } }).complete(claudeRequest({ onText: t => { text += t; }, onNotice: t => notices.push(t) }));
    expect(turn.stop).toBe("end"); expect(text).toBe("hello");
    expect(s.requests()).toBe(3);
    expect(notices).toEqual([expect.stringMatching(/^claude request failed \(HTTP 529\); retrying in \d\.\d\ds \(1\/3\)$/)]);
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
    let noticed = false;
    const result = anthropic(s.client, { retry: { backoffMs: [60_000] } }).complete(claudeRequest({ signal: controller.signal, onNotice: () => { noticed = true; } }));
    while (!noticed) await Bun.sleep(1);
    controller.abort(reason);
    expect(await result.catch(e => e)).toBe(reason);
    expect(s.requests()).toBe(2); // the SDK's own retry, then ours was waiting
  } finally { await s.stop(); }
});

test("Claude: a stream that fails after its first event is not retried", async () => {
  const s = await claudeServer(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(sse(claudeEvents.slice(0, 3))));
    setTimeout(() => controller.close(), 5); // the connection ends before message_stop
  } }), { headers: { "content-type": "text/event-stream" } }));
  try {
    const notices: string[] = [];
    await expect(anthropic(s.client, { retry: { backoffMs: [1, 1, 1] } }).complete(claudeRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow();
    expect(s.requests()).toBe(1); expect(notices).toEqual([]);
  } finally { await s.stop(); }
});

// ---- the Codex client, over the real SDK with fetch intercepted (its base URL is fixed) ----

let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; });
function intercept(respond: (n: number, request: Request) => Promise<Response>) {
  let requests = 0;
  mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      respond(++requests, input instanceof Request ? new Request(input, init as RequestInit) : new Request(String(input), init as RequestInit)),
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
  expect(notices).toEqual([expect.stringMatching(/^codex request failed \(connection error\); retrying in \d\.\d\ds \(1\/3\)$/)]);
});

test("Codex: a 500 is retried up to the bound, then fails; a 400 is not retried", async () => {
  let requests = intercept(async () => Response.json({ error: { message: "down" } }, { status: 500 }));
  const notices: string[] = [];
  await expect(openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow(/500/);
  expect(requests()).toBe(4); expect(notices).toHaveLength(3);
  mockFetch!.mockRestore();
  requests = intercept(async () => Response.json({ error: { message: "bad request" } }, { status: 400 }));
  await expect(openai(async () => fakeCodexTokens(), { retry: { backoffMs: [1, 1, 1] } }).complete(codexRequest({ onNotice: t => notices.push(t) }))).rejects.toThrow(/400/);
  expect(requests()).toBe(1); expect(notices).toHaveLength(3);
});

test("Codex: a cancel during the backoff rejects with the cancellation at once, with no further request", async () => {
  const requests = intercept(async () => Response.json({ error: { message: "down" } }, { status: 503 }));
  const controller = new AbortController(), reason = new Error("cancelled by user");
  let noticed = false;
  const result = openai(async () => fakeCodexTokens(), { retry: { backoffMs: [60_000] } }).complete(codexRequest({ signal: controller.signal, onNotice: () => { noticed = true; } }));
  while (!noticed) await Bun.sleep(1);
  controller.abort(reason);
  expect(await result.catch(e => e)).toBe(reason);
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
