import { afterEach, expect, spyOn, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { fromResponses, openai, toResponses, toResponseTools } from "./openai";
import { providerFor } from "./index";
import { codexSSE, fakeCodexTokens } from "../test/codex";

let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; });
function intercept(handler: (request: Request) => Promise<Response>) {
  mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const options = init as RequestInit | undefined;
      return handler(input instanceof Request ? new Request(input, options) : new Request(String(input), options));
    }, { preconnect: fetch.preconnect },
  ));
}
const call: ResponseOutputItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"pwd"}', status: "completed" };
const reasoning: ResponseOutputItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Checking the directory." }], encrypted_content: "test-encrypted-reasoning" };
const message: ResponseOutputItem = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] };
const request = (onText = (_: string) => {}) => ({ model: "gpt-test", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxTokens: 100, onText });

test("providerFor routes claude models to Claude Code and the rest to Codex", () => {
  expect(providerFor("claude-opus-5-5")).toBe("anthropic");
  expect(providerFor("gpt-test")).toBe("openai");
});

test("Responses translation preserves tool IDs, errors, text order and encrypted Codex reasoning", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "run pwd" },
    { role: "assistant", content: [{ type: "thinking", thinking: "Claude thinking", signature: "claude-signature" }, ...fromResponses([reasoning, message, call])] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "failed", is_error: true }, { type: "text", text: "try again" }] },
  ];
  expect(toResponses(messages)).toEqual([
    { role: "user", content: [{ type: "input_text", text: "run pwd" }] },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "test-encrypted-reasoning" },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"pwd"}' },
    { type: "function_call_output", call_id: "call_1", output: "Error: failed" },
    { role: "user", content: [{ type: "input_text", text: "try again" }] },
  ]);
});

test("tools use Responses function schemas", () => {
  const schema = { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] };
  expect(toResponseTools([{ name: "bash", description: "run", input_schema: schema }])).toEqual([
    { type: "function", name: "bash", description: "run", parameters: schema, strict: false },
  ]);
});

test("Codex streams text and tool calls through its subscription endpoint", async () => {
  const tokens = fakeCodexTokens();
  let incoming: Request | undefined;
  intercept(async (req) => {
    incoming = req;
    return codexSSE([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.completed", response: { status: "completed", output: [reasoning, message, call] } },
    ]);
  });
  let text = "";
  const result = await openai(async () => tokens).complete(request((delta) => { text += delta; }));
  expect(text).toBe("hello");
  expect(result.stop).toBe("tool_use");
  expect(result.content).toEqual(fromResponses([reasoning, message, call]));
  expect(incoming!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(incoming!.headers.get("authorization")).toBe(`Bearer ${tokens.accessToken}`);
  expect(incoming!.headers.get("chatgpt-account-id")).toBe(tokens.accountId);
  expect(incoming!.headers.get("originator")).toBe("codex_cli_rs");
  expect(incoming!.headers.get("openai-beta")).toBe("responses=experimental");
  expect(incoming!.headers.get("x-api-key")).toBeNull();
  const body = await incoming!.json() as Record<string, unknown>;
  expect(body).toMatchObject({ model: "gpt-test", store: false, stream: true, instructions: "You are Codex, an AI coding agent.", include: ["reasoning.encrypted_content"] });
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(body).not.toHaveProperty("messages");
});

test("Codex retries an initial 401 once using refreshed subscription credentials", async () => {
  const tokens = fakeCodexTokens();
  const rotated = fakeCodexTokens("test-account", Date.now() + 3_600_000, "rotated");
  const credentialsCalls: boolean[] = [];
  const authorizations: (string | null)[] = [];
  intercept(async (req) => {
    authorizations.push(req.headers.get("authorization"));
    if (authorizations.length === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
    return codexSSE([{ type: "response.completed", response: { output: [message] } }]);
  });
  const result = await openai(async (opts) => {
    credentialsCalls.push(Boolean(opts?.forceRefresh));
    return opts?.forceRefresh ? rotated : tokens;
  }).complete(request());
  expect(result.stop).toBe("end");
  expect(credentialsCalls).toEqual([false, true]);
  expect(authorizations).toEqual([`Bearer ${tokens.accessToken}`, `Bearer ${rotated.accessToken}`]);
});

test("a second 401 fails instead of falling back to API billing", async () => {
  let requests = 0;
  intercept(async (req) => {
    requests++;
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    return Response.json({ error: { message: "expired" } }, { status: 401 });
  });
  await expect(openai(async () => fakeCodexTokens()).complete(request())).rejects.toThrow();
  expect(requests).toBe(2);
});

test("model discovery uses the Codex catalog rather than the platform model API", async () => {
  intercept(async (req) => {
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toBeTruthy();
    return Response.json({ models: [{ slug: "later", priority: 2 }, { slug: "hidden", visibility: "hide" }, { slug: "first", priority: 1 }] });
  });
  expect(await openai(async () => fakeCodexTokens()).models()).toEqual(["first", "later"]);
});

test("completed streams can reconstruct output from done items in wire order", async () => {
  intercept(async () => codexSSE([
    { type: "response.output_item.done", output_index: 1, item: call },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { status: "completed" } },
  ]));
  const result = await openai(async () => fakeCodexTokens()).complete(request());
  expect(result.content).toEqual(fromResponses([message, call]));
});

test("Codex response.done is accepted only with a successful completion status", async () => {
  intercept(async () => codexSSE([{ type: "response.done", response: { status: "completed", output: [message] } }]));
  expect((await openai(async () => fakeCodexTokens()).complete(request())).stop).toBe("end");
  mockFetch!.mockRestore();
  intercept(async () => codexSSE([{ type: "response.done", response: { status: "incomplete", output: [call] } }]));
  await expect(openai(async () => fakeCodexTokens()).complete(request())).rejects.toThrow("did not complete");
});

test("failed, incomplete and truncated streams never return executable tool calls", async () => {
  for (const terminal of ["response.failed", "response.incomplete", null]) {
    let attempts = 0;
    intercept(async () => {
      attempts++;
      return codexSSE([
        { type: "response.output_item.done", output_index: 0, item: call },
        ...(terminal ? [{ type: terminal, response: { status: "failed" } }] : []),
      ]);
    });
    await expect(openai(async () => fakeCodexTokens()).complete(request())).rejects.toThrow();
    expect(attempts).toBe(1);
    mockFetch!.mockRestore();
  }
});

test("malformed tool arguments fail instead of being executed as an empty command", () => {
  expect(() => fromResponses([{ ...call, type: "function_call", arguments: "not-json" } as ResponseOutputItem])).toThrow("invalid tool arguments");
  expect(() => fromResponses([{ ...call, type: "function_call", arguments: "[]" } as ResponseOutputItem])).toThrow("invalid tool call");
  expect(() => fromResponses([{ ...call, status: "incomplete" } as ResponseOutputItem])).toThrow("unfinished");
});

test("Codex subscription wire payload sends selected effort/priority, omits them by default", async () => {
  const bodies: Record<string, unknown>[] = [];
  intercept(async (req) => {
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    bodies.push(await req.json() as Record<string, unknown>);
    return codexSSE([{ type: "response.completed", response: { status: "completed", output: [message] } }]);
  });
  const provider = openai(async () => fakeCodexTokens());
  await provider.complete({ ...request(), model: "gpt-6-astra", settings: { effort: "max", fast: true } });
  await provider.complete({ ...request(), model: "gpt-6-astra" });
  expect(bodies[0]).toMatchObject({ reasoning: { summary: "auto", effort: "max" }, service_tier: "priority" });
  expect(bodies[1]).toMatchObject({ reasoning: { summary: "auto" } });
  expect(bodies[1]).not.toHaveProperty("service_tier");
  expect(bodies[1]!.reasoning).not.toHaveProperty("effort");
});
test("Codex terminal metadata distinguishes refusal and omitted nontext output for summary safety", async () => {
  const refusal: ResponseOutputItem = { type: "message", id: "refused", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "cannot comply" }] };
  let output: ResponseOutputItem[] = [message, refusal];
  intercept(async () => codexSSE([{ type: "response.completed", response: { status: "completed", output } }]));
  const p = openai(async () => fakeCodexTokens());
  expect((await p.complete(request())).completion).toBe("refusal");
  output = [message, { ...reasoning, encrypted_content: undefined }];
  expect((await p.complete(request())).completion).toBe("completed");
  output = [reasoning, message]; expect((await p.complete(request())).completion).toBe("completed");
  output = [message, call]; expect((await p.complete(request())).completion).toBe("nontext");
  output = [message]; expect((await p.complete(request())).completion).toBe("completed");
});
