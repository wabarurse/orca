import { afterEach, expect, spyOn, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { claudeSearchResults, codexSearchResults } from "./search-results";
import { boundedSearchResponse, SEARCH_RESPONSE_BYTES, searchOperation } from "./web-search";
import { web_search } from "../tools/web-search";
import { codexSSE, fakeCodexTokens } from "../test/codex";
import { claudeSearchFixture, codexSearchFixture } from "../test/web-search";
import type { Provider } from "./index";
import { CLAUDE_BETAS } from "../claude-auth";

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
      await expect(invoke(make())).rejects.toThrow("web_search: native search failed or is unsupported by this model/account. No fallback was attempted.");
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
  await expect(big.text()).rejects.toThrow("exceeded the 2 MiB limit");
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
  await expect(invoke(provider)).rejects.toThrow("web_search: native search failed or is unsupported by this model/account. No fallback was attempted.");
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
