import { afterEach, expect, spyOn, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { codexSSE, fakeCodexTokens } from "../test/codex";
import type { RecoveryPolicy } from "./provider-recovery";

let mock: ReturnType<typeof spyOn> | undefined;
afterEach(() => { mock?.mockRestore(); });
const encoder = new TextEncoder();
const req = { model: "test", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxTokens: 100, onText() {} };
const policy: RecoveryPolicy = { enabled: true, idleMs: 100, totalMs: 1000 };
const claudeEvents = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const sse = (events: typeof claudeEvents) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
for (const name of ["claude", "codex"] as const) {
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
    await expect(provider.complete({ ...req, onNotice: n => notices.push(n) })).rejects.toMatchObject({ kind: "exhausted" });
    expect(calls).toBe(3);
    expect(events).toHaveLength(2);
    expect(notices).toHaveLength(2);
    expect(notices.join()).not.toContain("SECRET");
    expect(notices[0]).toContain("attempt 2, nextRetryAt");
  });
  test(`${name}: transport failures have no nested SDK retries`, async () => {
    let calls = 0;
    const provider = make(fetcher(async () => { calls++; throw new TypeError("fetch failed"); }));
    await expect(provider.complete(req)).rejects.toMatchObject({ kind: "exhausted" });
    expect(calls).toBe(3);
  });
  test(`${name}: quota is terminal`, async () => {
    let calls = 0;
    const provider = make(fetcher(async () => { calls++; return Response.json({ error: { type: "insufficient_quota" } }, { status: 429 }); }));
    await expect(provider.complete(req)).rejects.toMatchObject({ kind: "quota" });
    expect(calls).toBe(1);
  });
  for (const stage of ["headers", "body", "partial"] as const) test(`${name}: stalled ${stage} is terminal, no replay`, async () => {
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
        if (pulls++) c.error(new TypeError("network disconnected"));
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
    // Explicitly omit the policy (make's default is for integration tests).
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
  await expect(anthropic(client, { recovery: policy }).complete(req)).rejects.toMatchObject({ kind: "permanent" });
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

for (const outcome of ["success", "rejected", "transient", "cancelled"] as const) test(`Codex opt-in 401 refresh: ${outcome}`, async () => {
  let calls = 0;
  const refresh: (boolean | undefined)[] = [];
  const authorization: (string | null)[] = [];
  const caller = new AbortController();
  const reason = new Error("stopped during refresh");
  const initial = fakeCodexTokens("test-account", Date.now() + 3600_000, "initial");
  const renewed = fakeCodexTokens("test-account", Date.now() + 3600_000, "renewed");
  mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    authorization.push(new Request(input, init).headers.get("authorization"));
    if (calls === 2 && outcome === "success") return codexSSE([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    return Response.json({ error: { type: "authentication_error" } }, { status: calls === 2 && outcome === "transient" ? 503 : 401 });
  }, { preconnect: fetch.preconnect }));
  const provider = openai(async opts => {
    refresh.push(opts?.forceRefresh);
    if (opts?.forceRefresh && outcome === "cancelled") caller.abort(reason);
    return opts?.forceRefresh || refresh.length > 1 ? renewed : initial;
  }, { recovery: policy, retry: { backoffMs: [0, 0] } });
  const result = provider.complete({ ...req, signal: caller.signal });
  if (outcome === "success") expect((await result).stop).toBe("end");
  else if (outcome === "cancelled") await expect(result).rejects.toBe(reason);
  else await expect(result).rejects.toMatchObject({ kind: "permanent" });
  expect(calls).toBe(outcome === "cancelled" ? 1 : outcome === "transient" ? 3 : 2);
  expect(refresh).toEqual(outcome === "transient" ? [undefined, true, undefined] : [undefined, true]);
  expect(authorization).toEqual([`Bearer ${initial.accessToken}`, ...Array(calls - 1).fill(`Bearer ${renewed.accessToken}`)]);
});
