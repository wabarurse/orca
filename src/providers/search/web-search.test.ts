import { afterEach, expect, spyOn, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../anthropic";
import { openai } from "../openai";
import { claudeSearchResults, codexSearchResults } from "./search-results";
import { boundedSearchResponse, SEARCH_RESPONSE_BYTES, SearchError, searchOperation } from "./web-search";
import { web_search } from "../../core/tools/web-search";
import { codexSSE, fakeCodexTokens } from "../../test/codex";
import { claudeSearchFixture, codexSearchFixture, codexStreamSearchFixture } from "../../test/web-search";
import type { Provider } from "../provider";
import { CLAUDE_BETAS } from "../../login/claude";

let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; });
function intercept(handler: (request: Request) => Promise<Response> | Response) {
  mockFetch?.mockRestore();
  mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(input instanceof Request ? new Request(input, init as RequestInit) : new Request(String(input), init as RequestInit)),
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
    project: "private-project", role: "reviewer", cwd: "/private-project", signal,
    selected: { provider, model: provider.name === "openai" ? "gpt-6-astra" : "claude-opus-5", settings: { effort: "high", fast: true } },
  });
}
function codexSuccess() { return codexSSE([{ type: "response.completed", response: { status: "completed", output: codexSearchFixture() } }]); }

test("Claude native search uses existing subscription auth, selected model/settings and only query input", async () => {
  let incoming!: Request;
  intercept(request => { incoming = request; return Response.json(claudeSearchFixture()); });
  const text = await invoke(claude());
  expect(incoming.url).toBe("https://api.anthropic.com/v1/messages");
  expect(incoming.headers.get("authorization")).toBe("Bearer test-only-oauth");
  expect(incoming.headers.get("x-api-key")).toBeNull();
  expect(incoming.headers.get("anthropic-beta")).toBe(`${CLAUDE_BETAS},fast-mode-2026-02-01`);
  const body = await incoming.json() as any;
  expect(body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" }, speed: "fast", max_tokens: 2048,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [{ role: "user", content: JSON.stringify({ query: "public docs", max_results: 2 }) }] });
  expect(body.system[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(JSON.stringify(body)).not.toContain("private-project");
  expect(text).toContain("An actual quoted excerpt.");
  expect(text).toContain("https://example.com/docs");
  expect(text).not.toContain("opaque-"); expect(text).not.toContain("generated answer");
});

test("Codex native search uses only subscription Responses and keeps structured URL citations, not fake snippets", async () => {
  let incoming!: Request;
  intercept(request => { incoming = request; return codexSuccess(); });
  const text = await invoke(codex());
  expect(incoming.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(incoming.headers.get("authorization")).toBe(`Bearer ${fakeCodexTokens().accessToken}`);
  expect(incoming.headers.get("chatgpt-account-id")).toBe("test-account");
  expect(incoming.headers.get("x-api-key")).toBeNull();
  const body = await incoming.json() as any;
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
  (fixture.content[1] as any).content = [];
  intercept(() => Response.json(fixture));
  expect(await invoke(claude())).toStartWith("Web search: 0 sources.");
});

test("native parsers reject unfinished, errored, missing and unsupported output without fabricating hits", () => {
  const badClaude: any[] = [];
  for (const stop_reason of ["pause_turn", "max_tokens", "tool_use", "refusal", null]) badClaude.push({ ...claudeSearchFixture(), stop_reason });
  for (const error_code of ["unavailable", "too_many_requests", "max_uses_exceeded", "invalid_tool_input"]) {
    const fixture = claudeSearchFixture();
    (fixture.content[1] as any).content = { type: "web_search_tool_result_error", error_code };
    badClaude.push(fixture);
  }
  badClaude.push({ ...claudeSearchFixture(), content: [claudeSearchFixture().content[2]] });
  badClaude.push({ ...claudeSearchFixture(), content: [claudeSearchFixture().content[0]] });
  const wrongID = claudeSearchFixture(); (wrongID.content[1] as any).tool_use_id = "other"; badClaude.push(wrongID);
  for (const fixture of badClaude) expect(() => claudeSearchResults(fixture)).toThrow();

  const badCodex: any[] = [[], codexSearchFixture().slice(1), codexSearchFixture().slice(0, 1)];
  for (const status of ["failed", "in_progress", "incomplete", "searching", undefined]) {
    const fixture = codexSearchFixture(); (fixture[0] as any).status = status; badCodex.push(fixture);
  }
  const openPage = codexSearchFixture(); (openPage[0] as any).action = { type: "open_page", url: "https://example.com" }; badCodex.push(openPage);
  const refused = codexSearchFixture(); (refused[1] as any).content = [{ type: "refusal", refusal: "no search" }]; badCodex.push(refused);
  badCodex.push([...codexSearchFixture(), { type: "function_call", name: "bash", arguments: "{}" }]);
  for (const fixture of badCodex) expect(() => codexSearchResults(fixture)).toThrow();
});

test("Codex supplied action source URLs survive without inventing a title or excerpt", () => {
  const fixture = codexSearchFixture().slice(0, 1);
  (fixture[0] as any).action.sources = [{ type: "url", url: "https://example.org/source" }];
  expect(codexSearchResults(fixture)).toEqual({ sources: [{ url: "https://example.org/source" }] });
});

for (const terminal of ["response.failed", "response.incomplete", "error", "missing", "no-status", "unfinished-item"]) {
  test(`Codex search rejects ${terminal} instead of returning partial hits`, async () => {
    const fixture = codexSearchFixture();
    if (terminal === "unfinished-item") (fixture[1] as any).status = "in_progress";
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
      const error = await invoke(make()).catch(e => e);
      expect(error).toBeInstanceOf(Error); expect(error.message).toContain("web_search:");
      expect(cancelled).toBe(true);
    }
  });
  test(`${make.name} abort disconnects a stalled body promptly`, async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let cancelled = false;
    intercept(() => { entered(); return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }); });
    const controller = new AbortController();
    const pending = invoke(make(), controller.signal);
    await started; await Bun.sleep(0); controller.abort();
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
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  intercept(() => { calls++; return codexSuccess(); });
  const provider = name === "codex" ? openai(async () => { entered(); await gate; return fakeCodexTokens(); })
    : anthropic(new Anthropic({ apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: async () => { entered(); await gate; return { token: "test-only", expiresAt: null }; } }));
  const controller = new AbortController();
  const pending = invoke(provider, controller.signal);
  await started; controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  release(); await Bun.sleep(10);
  expect(calls).toBe(0);
});


test("Codex search refreshes only the same account once on initial 401", async () => {
  const requests: Request[] = [], refresh: boolean[] = [];
  intercept(request => {
    requests.push(request);
    return requests.length === 1 ? Response.json({ error: { message: "SECRET initial authentication failure" } }, { status: 401 }) : codexSuccess();
  });
  const provider = openai(async options => {
    refresh.push(!!options?.forceRefresh);
    return fakeCodexTokens("same-account", Date.now() + 3600000, options?.forceRefresh ? "refreshed" : "original");
  });
  expect(await invoke(provider)).toContain("https://example.com/docs");
  expect(refresh).toEqual([false, true]);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.headers.get("chatgpt-account-id")).toBe("same-account");
    expect((await request.json() as any).model).toBe("gpt-6-astra");
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
  await expect(web_search.run({ query: "public docs" }, { project: "p", role: "worker", cwd: "/never-read",
    selected: { provider: make(), model: "unknown-model", settings: { fast: true } },
  })).rejects.toThrow("web_search:");
  expect(calls).toBe(0);
});

for (const type of ["response.completed", "response.done"]) test(`live-shaped Codex ${type} output: [] retains completed done items and citations`, async () => {
  const { events, terminal } = codexStreamSearchFixture();
  intercept(() => codexSSE([...events, { ...terminal, type }]));
  const text = await invoke(codex());
  expect(text).toStartWith("Web search: 2 sources (limited).");
  expect(JSON.parse(text.split("\n")[2]!)).toEqual({ limited: true, sources: [
    { url: "https://example.org/docs/0", title: "Public docs 0" },
    { url: "https://example.org/docs/1", title: "Public docs 1" },
  ] });
  expect(text).not.toContain("synthetic"); expect(text).not.toContain("Generated answer");
  expect(text).not.toContain('"excerpt"');
});

async function expectSearchCode(events: unknown[], code: SearchError["code"]) {
  intercept(() => codexSSE(events));
  const error = await invoke(codex()).catch(error => error);
  expect(error).toBeInstanceOf(SearchError);
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
    // The SDK consumes generic error events itself before yielding them.
    const failure = type === "error" ? { type, error: { message: "SECRET" } }
      : { type, response: { status: type.slice(9), error: { message: "SECRET" } } };
    await expectSearchCode([...events, failure], type === "error" ? "failed" : "incomplete");
  }
  await expectSearchCode([terminal], "no_search");
  await expectSearchCode(events.filter(e => e.type !== "response.output_item.done").concat(terminal as any), "no_search");
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
  let cancelled = false, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  intercept(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      started();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const controller = new AbortController();
  const pending = invoke(codex(), controller.signal);
  await entered; await Bun.sleep(0); controller.abort(new Error("SECRET"));
  await expect(pending).rejects.toThrow(new SearchError("cancelled").message);
  expect(cancelled).toBe(true);
});
