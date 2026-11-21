import { afterEach, expect, spyOn, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../anthropic";
import { openai } from "../openai";
import { claudeSearchResults, codexSearchResults } from "./search-results";
import { boundedSearchResponse, SEARCH_RESPONSE_BYTES, SearchError, searchOperation } from "./web-search";
import { web_search } from "../../core/tools/web-search";
import type { ToolContext } from "../../core/tools/registry";

const toolContext = (signal: AbortSignal): Omit<ToolContext, "provider" | "model" | "settings"> => ({ conversation: "c-00000000", agent: "reviewer-x", role: "reviewer", branch: "x",
  cwd: "/private-project", data: "/never", trusted: false, pluginSkills: [], callId: "call", signal,
  runtime: { spawn: async () => { throw new Error("no"); }, agents: async () => [], stop: async () => "", confirm: async () => false } });
import { codexSSE, fakeCodexTokens } from "../../test/codex";
import { claudeSearchFixture, codexSearchFixture, codexStreamSearchFixture } from "../../test/web-search";
import type { Provider } from "../provider";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { CLAUDE_BETAS } from "../anthropic";

let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; });
function intercept(handler: (request: Request) => Promise<Response> | Response) {
  mockFetch?.mockRestore();
  mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
    { preconnect: fetch.preconnect },
  ));
}
function claude() {
  return anthropic(new Anthropic({ apiKey: null, authToken: "test-only-oauth", baseURL: "https://api.anthropic.com",
    defaultHeaders: { "anthropic-beta": CLAUDE_BETAS, "x-api-key": null }, fetchOptions: { redirect: "error" } }));
}
const codex = () => openai(async () => fakeCodexTokens());
function invoke(provider: Provider, signal?: AbortSignal) {
  return web_search.run({ query: "public docs", max_results: 2 }, {
    ...toolContext(signal ?? new AbortController().signal), provider, model: provider.name === "openai" ? "gpt-6-astra" : "claude-opus-5", settings: { effort: "high", fast: true },
  });
}
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("fixture is empty");
  return item;
}
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`fixture has no item ${index}`);
  return item;
}
function codexSuccess() { return codexSSE([{ type: "response.completed", response: { status: "completed", output: codexSearchFixture() } }]); }

test("Claude native search uses existing subscription auth, selected model/settings and only query input", async () => {
  const requests: Request[] = [];
  intercept(request => { requests.push(request); return Response.json(claudeSearchFixture()); });
  const text = await invoke(claude());
  const incoming = first(requests);
  expect(incoming.url).toBe("https://api.anthropic.com/v1/messages");
  expect(incoming.headers.get("authorization")).toBe("Bearer test-only-oauth");
  expect(incoming.headers.get("x-api-key")).toBeNull();
  expect(incoming.headers.get("anthropic-beta")).toBe(`${CLAUDE_BETAS},fast-mode-2026-02-01`);
  const body: unknown = await incoming.json();
  expect(body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" }, speed: "fast", max_tokens: 2048,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [{ role: "user", content: JSON.stringify({ query: "public docs", max_results: 2 }) }] });
  expect(body).toHaveProperty(["system", 0, "text"], "You are Claude Code, Anthropic's official CLI for Claude.");
  expect(JSON.stringify(body)).not.toContain("private-project");
  expect(text).toContain("An actual quoted excerpt.");
  expect(text).toContain("https://example.com/docs");
  expect(text).not.toContain("opaque-"); expect(text).not.toContain("generated answer");
});

test("Codex native search uses only subscription Responses and keeps structured URL citations, not fake snippets", async () => {
  const requests: Request[] = [];
  intercept(request => { requests.push(request); return codexSuccess(); });
  const text = await invoke(codex());
  const incoming = first(requests);
  expect(incoming.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(incoming.headers.get("authorization")).toBe(`Bearer ${fakeCodexTokens().accessToken}`);
  expect(incoming.headers.get("chatgpt-account-id")).toBe("test-account");
  expect(incoming.headers.get("x-api-key")).toBeNull();
  const body: unknown = await incoming.json();
  expect(body).toMatchObject({ model: "gpt-6-astra", store: false, stream: true, reasoning: { effort: "high", summary: "auto" }, service_tier: "priority",
    tools: [{ type: "web_search", external_web_access: true, search_context_size: "low" }],
    input: [{ role: "user", content: JSON.stringify({ query: "public docs", max_results: 2 }) }] });
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(JSON.stringify(body)).not.toContain("private-project");
  expect(text).toContain('"title":"Public docs"'); expect(text).toContain("https://example.org/guide");
  expect(text).not.toContain('"excerpt"'); expect(text).not.toContain("generated answer");
});

test("Codex search reconstruction accepts done events only with terminal completed status", async () => {
  const output = codexSearchFixture();
  intercept(() => codexSSE([
    ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.done", response: { status: "completed" } },
  ]));
  expect(await invoke(codex())).toContain("https://example.com/docs");
});

test("Claude only returns zero results after a completed native search with an explicit empty result list", async () => {
  const fixture = claudeSearchFixture();
  fixture.content = fixture.content.slice(0, 2);
  Object.assign(at(fixture.content, 1), { content: [] });
  intercept(() => Response.json(fixture));
  expect(await invoke(claude())).toStartWith("Web search: 0 sources.");
});

test("native parsers reject unfinished, errored, missing and unsupported output without fabricating hits", () => {
  const badClaude: Message[] = [];
  const stops: Message["stop_reason"][] = ["pause_turn", "max_tokens", "tool_use", "refusal", null];
  for (const stop_reason of stops) badClaude.push({ ...claudeSearchFixture(), stop_reason });
  for (const error_code of ["unavailable", "too_many_requests", "max_uses_exceeded", "invalid_tool_input"]) {
    const fixture = claudeSearchFixture();
    Object.assign(at(fixture.content, 1), { content: { type: "web_search_tool_result_error", error_code } });
    badClaude.push(fixture);
  }
  badClaude.push({ ...claudeSearchFixture(), content: claudeSearchFixture().content.slice(2, 3) });
  badClaude.push({ ...claudeSearchFixture(), content: claudeSearchFixture().content.slice(0, 1) });
  const wrongID = claudeSearchFixture(); Object.assign(at(wrongID.content, 1), { tool_use_id: "other" }); badClaude.push(wrongID);
  for (const fixture of badClaude) expect(claudeSearchResults(fixture).ok).toBe(false);

  const badCodex: ResponseOutputItem[][] = [[], codexSearchFixture().slice(1), codexSearchFixture().slice(0, 1)];
  for (const status of ["failed", "in_progress", "incomplete", "searching", undefined]) {
    const fixture = codexSearchFixture(); Object.assign(first(fixture), { status }); badCodex.push(fixture);
  }
  const openPage = codexSearchFixture(); Object.assign(first(openPage), { action: { type: "open_page", url: "https://example.com" } }); badCodex.push(openPage);
  const refused = codexSearchFixture(); Object.assign(at(refused, 1), { content: [{ type: "refusal", refusal: "no search" }] }); badCodex.push(refused);
  badCodex.push([...codexSearchFixture(), { type: "function_call", call_id: "call", name: "bash", arguments: "{}" }]);
  for (const fixture of badCodex) expect(codexSearchResults(fixture).ok).toBe(false);
});

test("Codex supplied action source URLs survive without inventing a title or excerpt", () => {
  const fixture = codexSearchFixture().slice(0, 1);
  const search = first(fixture);
  if (search.type !== "web_search_call" || search.action.type !== "search") throw new Error("fixture is not a search call");
  search.action.sources = [{ type: "url", url: "https://example.org/source" }];
  expect(codexSearchResults(fixture)).toEqual({ ok: true, data: { sources: [{ url: "https://example.org/source" }] } });
});

for (const terminal of ["response.failed", "response.incomplete", "error", "missing", "no-status", "unfinished-item"]) {
  test(`Codex search rejects ${terminal} instead of returning partial hits`, async () => {
    const fixture = codexSearchFixture();
    if (terminal === "unfinished-item") Object.assign(at(fixture, 1), { status: "in_progress" });
    const events: unknown[] = [{ type: "response.output_item.done", output_index: 0, item: fixture[0] }];
    if (terminal === "no-status" || terminal === "unfinished-item") events.push({ type: "response.completed", response: { ...(terminal === "unfinished-item" ? { status: "completed" } : {}), output: fixture } });
    else if (terminal !== "missing") events.push({ type: terminal, message: "SECRET-provider-error", error: { message: "SECRET-provider-error" } });
    intercept(() => codexSSE(events));
    await expect(invoke(codex())).rejects.toThrow(/web_search:/);
  });
}

for (const make of [claude, codex]) {
  test(`${make.name} errors are sanitized, no 429/5xx retry or alternate endpoint/account`, async () => {
    for (const status of [400, 403, 429, 500]) {
      let calls = 0;
      intercept(() => { calls++; return Response.json({ error: { message: "SECRET raw server content", type: "unsupported" } }, { status }); });
      await expect(invoke(make())).rejects.toThrow("web_search: native search failed or is unsupported by this model/account. no fallback was attempted.");
      expect(calls).toBe(1);
    }
  });
  test(`${make.name} response bounds apply before SDK parsing, including enormous HTTP errors`, async () => {
    for (const status of [200, 500]) {
      let cancelled = false;
      intercept(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SEARCH_RESPONSE_BYTES + 1)); }, cancel() { cancelled = true; } }), { status, headers: { "content-type": "application/json" } }));
      const error = await caught(invoke(make()));
      expect(error).toBeInstanceOf(Error); expect(error instanceof Error ? error.message : "").toContain("web_search:");
      expect(cancelled).toBe(true);
    }
  });
  test(`${make.name} abort disconnects a stalled body promptly`, async () => {
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    intercept(() => { started.resolve(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }); });
    const controller = new AbortController();
    const pending = invoke(make(), controller.signal);
    await started.promise; await Bun.sleep(0); controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });
}

test("bounded transport explicitly reports its byte limit and disconnects at the deadline", async () => {
  const controller = new AbortController();
  const big = boundedSearchResponse(new Response(new Uint8Array(SEARCH_RESPONSE_BYTES + 1)), controller.signal);
  await expect(big.text()).rejects.toThrow("exceeded the 2 mib limit");
  let cancelled = false;
  await expect(searchOperation(undefined, signal => boundedSearchResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), signal).text(), 5)).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

for (const name of ["claude", "codex"]) test(`${name} cancellation during delayed credentials cannot dispatch a later model request`, async () => {
  const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  let calls = 0;
  intercept(() => { calls++; return codexSuccess(); });
  const provider = name === "codex" ? openai(async () => { started.resolve(); await gate.promise; return fakeCodexTokens(); })
    : anthropic(new Anthropic({ apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: async () => { started.resolve(); await gate.promise; return { token: "test-only", expiresAt: null }; } }));
  const controller = new AbortController();
  const pending = invoke(provider, controller.signal);
  await started.promise; controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  gate.resolve(); await Bun.sleep(10);
  expect(calls).toBe(0);
});


test("Codex search refreshes only the same account once on initial 401", async () => {
  const requests: Request[] = [], refresh: boolean[] = [];
  intercept(request => {
    requests.push(request);
    return requests.length === 1 ? Response.json({ error: { message: "SECRET initial authentication failure" } }, { status: 401 }) : codexSuccess();
  });
  const provider = openai(async options => {
    refresh.push(options?.forceRefresh === true);
    return fakeCodexTokens("same-account", Date.now() + 3600000, options?.forceRefresh === true ? "refreshed" : "original");
  });
  expect(await invoke(provider)).toContain("https://example.com/docs");
  expect(refresh).toEqual([false, true]);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.headers.get("chatgpt-account-id")).toBe("same-account");
    const body: unknown = await request.json();
    expect(body).toHaveProperty("model", "gpt-6-astra");
  }
});

test("Codex search fails safely after a second 401 without another account or billing path", async () => {
  let calls = 0, credentials = 0;
  intercept(() => { calls++; return Response.json({ error: { message: "SECRET unauthorized" } }, { status: 401 }); });
  const provider = openai(async () => { credentials++; return fakeCodexTokens(); });
  await expect(invoke(provider)).rejects.toThrow("web_search: native search failed or is unsupported by this model/account. no fallback was attempted.");
  expect(calls).toBe(2); expect(credentials).toBe(2);
});

for (const make of [claude, codex]) test(`${make.name} invalid explicit settings fail before dispatch rather than silently using defaults`, async () => {
  let calls = 0;
  intercept(() => { calls++; return codexSuccess(); });
  await expect(web_search.run({ query: "public docs" }, { ...toolContext(new AbortController().signal),
    provider: make(), model: "unknown-model", settings: { fast: true },
  })).rejects.toThrow("web_search:");
  expect(calls).toBe(0);
});

for (const type of ["response.completed", "response.done"]) test(`live-shaped Codex ${type} output: [] retains completed done items and citations`, async () => {
  const { events, terminal } = codexStreamSearchFixture();
  intercept(() => codexSSE([...events, { ...terminal, type }]));
  const text = String(await invoke(codex()));
  expect(text).toStartWith("Web search: 2 sources (limited).");
  const payload: unknown = JSON.parse(text.split("\n")[2] ?? "");
  expect(payload).toEqual({ limited: true, sources: [
    { url: "https://example.org/docs/0", title: "Public docs 0" },
    { url: "https://example.org/docs/1", title: "Public docs 1" },
  ] });
  expect(text).not.toContain("synthetic"); expect(text).not.toContain("Generated answer");
  expect(text).not.toContain('"excerpt"');
});

async function expectSearchCode(events: unknown[], code: SearchError["code"]) {
  intercept(() => codexSSE(events));
  const error = await caught(invoke(codex()));
  expect(error).toBeInstanceOf(SearchError);
  if (!(error instanceof SearchError)) return;
  expect(error.code).toBe(code);
  expect(error.message).toBe(new SearchError(code).message);
  expect(error.message).not.toContain("SECRET");
}

for (const status of [undefined, "in_progress", "incomplete", "failed"]) test(`done items plus empty terminal output cannot rescue ${status} response status`, async () => {
  const { events, terminal } = codexStreamSearchFixture();
  await expectSearchCode([...events, { ...terminal, response: { status, output: [], error: "SECRET" } }], "incomplete");
});

test("live-shaped done items need terminal success, not just citations or search completion events", async () => {
  const { events, terminal } = codexStreamSearchFixture();
  await expectSearchCode(events, "incomplete");
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    const failure = type === "error" ? { type, error: { message: "SECRET" } }
      : { type, response: { status: type.slice(9), error: { message: "SECRET" } } };
    await expectSearchCode([...events, failure], type === "error" ? "failed" : "incomplete");
  }
  await expectSearchCode([terminal], "no_search");
  await expectSearchCode([...events.filter(e => e.type !== "response.output_item.done"), terminal], "no_search");
});

for (const status of ["failed", "in_progress", "searching", "incomplete", undefined]) test(`a ${status} native done action cannot be hidden by later successful final output`, async () => {
  const { events, output } = codexStreamSearchFixture();
  const failed = { ...output[1], status };
  const modified = events.map(event => event.type === "response.output_item.done" && event.output_index === 1 ? { ...event, item: failed } : event);
  for (const finalOutput of [[], output]) {
    await expectSearchCode([...modified, { type: "response.completed", response: { status: "completed", output: finalOutput } }], "native");
  }
});

test("empty-output reconstruction fails closed on malformed items, refusals and unsupported actions", async () => {
  const { output } = codexStreamSearchFixture();
  const bad: [unknown, SearchError["code"]][] = [
    [null, "malformed"],
    [{ ...output[1], action: undefined }, "malformed"],
    [{ ...output[1], action: { type: "search", sources: {} } }, "malformed"],
    [{ ...output[1], action: { type: "open_page", url: "https://example.com" } }, "action"],
    [{ type: "function_call", name: "bash", arguments: "SECRET" }, "action"],
    [{ ...output.at(-1), content: [{ type: "refusal", refusal: "SECRET" }] }, "refusal"],
    [{ ...output.at(-1), content: [{ type: "output_text", text: "SECRET", annotations: {} }] }, "malformed"],
    [{ ...output[0], status: "incomplete" }, "incomplete"],
  ];
  for (const [item, code] of bad) {
    const { events, terminal } = codexStreamSearchFixture();
    await expectSearchCode([...events, { type: "response.output_item.done", output_index: 8, item }, terminal], code);
  }
});

test("reconstruction rejects sparse, duplicate and invalid indices or a malformed terminal output", async () => {
  for (const output_index of [-1, 0.5, 0, 10]) {
    const { events, terminal, output } = codexStreamSearchFixture();
    await expectSearchCode([...events, { type: "response.output_item.done", output_index, item: output[0] }, terminal], "malformed");
  }
  const { events, terminal } = codexStreamSearchFixture();
  await expectSearchCode([...events, { ...terminal, response: { status: "completed", output: {} } }], "malformed");
});

test("no-search, missing-attribution and refusal have distinct safe error classifications", async () => {
  const { terminal, output } = codexStreamSearchFixture();
  for (const [items, code] of [
    [[output.at(-1)], "no_search"],
    [[output[1]], "sources"],
    [[{ ...output.at(-1), content: [{ type: "refusal", refusal: "SECRET" }] }], "refusal"],
  ] as const) await expectSearchCode([{ ...terminal, response: { status: "completed", output: items } }], code);
});

test("cancellation after live-shaped done items does not return partial sources or wait for the terminal event", async () => {
  const { events } = codexStreamSearchFixture();
  let cancelled = false;
  const entered = Promise.withResolvers<void>();
  intercept(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      entered.resolve();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const controller = new AbortController();
  const pending = invoke(codex(), controller.signal);
  await entered.promise; await Bun.sleep(0); controller.abort(new Error("SECRET"));
  await expect(pending).rejects.toThrow(new SearchError("cancelled").message);
  expect(cancelled).toBe(true);
});
