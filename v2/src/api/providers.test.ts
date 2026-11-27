import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Tool as ApiTool, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseFunctionToolCall, ResponseOutputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { usageEvent } from "../config";
import { codexSSE, fakeCodexTokens } from "../test/codex";
import { fakeProvider, text } from "../test/fake-provider";
import { png } from "../test/image-fixture";
import { anthropic, claudeMessages, claudeRequestSettings } from "./anthropic";
import { ModelRequestError } from "./errors/bounded-request";
import { modelCapabilities } from "./model/capabilities";
import { clearCatalogLimits, contextWindow } from "./model/context-window";
import { codexRequestSettings, fromResponses, openai, toResponses, toResponseTools } from "./openai";
import type { CompleteRequest } from "./provider";
import { metered, recordRetry, usageScope } from "./usage";

describe("Codex requests and replies", () => {
  let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => { mockFetch?.mockRestore(); mockFetch = undefined; clearCatalogLimits(); });
  function intercept(handler: (request: Request) => Promise<Response>) {
    mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        return handler(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      }, { preconnect: fetch.preconnect },
    ));
  }
  const call: ResponseOutputItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"pwd"}', status: "completed" };
  const reasoning: ResponseOutputItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Checking the directory." }], encrypted_content: "test-encrypted-reasoning" };
  const message: ResponseOutputItem = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] };
  const bodyShape = z.record(z.string(), z.unknown());
  async function json(req: Request): Promise<Record<string, unknown>> {
    const body: unknown = await req.json();
    return bodyShape.parse(body);
  }
  const request = (onText: (text: string) => void = () => {}): CompleteRequest => ({ model: "gpt-test", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100, onText });

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
    const schema: ApiTool["input_schema"] = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
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
    if (incoming === undefined) throw new Error("no request was sent");
    expect(incoming.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(incoming.headers.get("authorization")).toBe(`Bearer ${tokens.accessToken}`);
    expect(incoming.headers.get("chatgpt-account-id")).toBe(tokens.accountId);
    expect(incoming.headers.get("originator")).toBe("codex_cli_rs");
    expect(incoming.headers.get("openai-beta")).toBe("responses=experimental");
    expect(incoming.headers.get("x-api-key")).toBeNull();
    const body = await json(incoming);
    expect(body).toMatchObject({ model: "gpt-test", store: false, stream: true, instructions: "You are Codex, an AI coding agent.", include: ["reasoning.encrypted_content"] });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("messages");
  });

  test.each([
    "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review",
  ])("%s sends image bytes to Codex with the selected model and settings", async model => {
    const data = png().toString("base64");
    let calls = 0;
    intercept(async req => {
      calls++;
      expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      const body = await json(req);
      expect(body.model).toBe(model);
      expect(body.reasoning).toEqual({ summary: "auto", effort: "high" });
      expect(body.service_tier).toBe("priority");
      expect(body.input).toEqual([{ role: "user", content: [
        { type: "input_text", text: "Inspect this screenshot" },
        { type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "auto" },
      ] }]);
      return codexSSE([{ type: "response.completed", response: { status: "completed", output: [message] } }]);
    });
    const messages: MessageParam[] = [{ role: "user", content: [
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ] }];
    await openai(async () => fakeCodexTokens()).complete({ ...request(), model, messages, settings: { effort: "high", fast: true } });
    expect(calls).toBe(1);
  });

  test.each(["gpt-unknown", "gpt-6-astra-unverified", "gpt-6-astra-2099-01-01", "gpt-3.5-turbo"])(
    "%s attempts image input without changing models", async model => {
      let credentials = 0, calls = 0;
      intercept(async req => {
        calls++;
        const body = await json(req);
        expect(body.model).toBe(model);
        expect(body).toHaveProperty(["input", 0, "content", 0], { type: "input_image", image_url: `data:image/png;base64,${png().toString("base64")}`, detail: "auto" });
        return codexSSE([{ type: "response.completed", response: { status: "completed", output: [message] } }]);
      });
      const provider = openai(async () => { credentials++; return fakeCodexTokens(); });
      const messages: MessageParam[] = [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: png().toString("base64") } },
      ] }];
      await provider.complete({ ...request(), model, messages });
      expect(credentials).toBe(1);
      expect(calls).toBe(1);
    },
  );

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
      credentialsCalls.push(opts?.forceRefresh === true);
      return opts?.forceRefresh === true ? rotated : tokens;
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

  test("codex catalog context_window fills gaps; absent, null and invalid values are ignored", async () => {
    intercept(async () => Response.json({ models: [{ slug: "gpt-a", context_window: 300000 }, { slug: "gpt-b" }, { slug: "gpt-c", context_window: null },
      { slug: "gpt-d", context_window: -1 }, { slug: "gpt-e", context_window: "1" }, { slug: "gpt-5.5", context_window: 1000000 }] }));
    await openai(async () => fakeCodexTokens()).models();
    expect(contextWindow({}, "gpt-a")).toEqual({ limit: 300000, estimated: false });
    for (const m of ["gpt-b", "gpt-c", "gpt-d", "gpt-e"]) expect(contextWindow({}, m)).toEqual({ limit: 128000, estimated: true });
    expect(contextWindow({}, "gpt-5.5").limit).toBe(272000);
  });

  test("codex catalog supported_reasoning_levels feed modelCapabilities; models without them keep the table", async () => {
    intercept(async () => Response.json({ models: [{ slug: "gpt-5.5", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] }, { slug: "gpt-6-astra" }, { slug: "gpt-x", supported_reasoning_levels: "low" }] }));
    await openai(async () => fakeCodexTokens()).models();
    expect(modelCapabilities("gpt-5.5").effort).toEqual(["medium", "high"]);
    expect(modelCapabilities("gpt-6-astra").effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelCapabilities("gpt-x").effort).toEqual([]);
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

  test("empty terminal output preserves streamed tool calls exactly once", async () => {
    intercept(async () => codexSSE([
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]));
    const result = await openai(async () => fakeCodexTokens()).complete(request());
    expect(result.stop).toBe("tool_use"); expect(result.content).toEqual(fromResponses([call]));
  });

  test("a gap in streamed output fails without returning executable calls", async () => {
    intercept(async () => codexSSE([
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ]));
    await expect(openai(async () => fakeCodexTokens()).complete(request())).rejects.toThrow();
  });

  test("Codex response.done is accepted only with a successful completion status", async () => {
    intercept(async () => codexSSE([{ type: "response.done", response: { status: "completed", output: [message] } }]));
    expect((await openai(async () => fakeCodexTokens()).complete(request())).stop).toBe("end");
    mockFetch?.mockRestore();
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
          ...(terminal !== null ? [{ type: terminal, response: { status: "failed" } }] : []),
        ]);
      });
      await expect(openai(async () => fakeCodexTokens()).complete(request())).rejects.toThrow();
      expect(attempts).toBe(1);
      mockFetch?.mockRestore();
    }
  });

  test("malformed tool arguments fail instead of being executed as an empty command", () => {
    const tool = (patch: Partial<ResponseFunctionToolCall>): ResponseFunctionToolCall => ({ type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"pwd"}', status: "completed", ...patch });
    expect(() => fromResponses([tool({ arguments: "not-json" })])).toThrow("invalid tool arguments");
    expect(() => fromResponses([tool({ arguments: "[]" })])).toThrow("invalid tool call");
    expect(() => fromResponses([tool({ status: "incomplete" })])).toThrow("unfinished");
  });

  test("Codex subscription wire payload sends selected effort/priority, omits them by default", async () => {
    const bodies: Record<string, unknown>[] = [];
    intercept(async (req) => {
      expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      bodies.push(await json(req));
      return codexSSE([{ type: "response.completed", response: { status: "completed", output: [message] } }]);
    });
    const provider = openai(async () => fakeCodexTokens());
    await provider.complete({ ...request(), model: "gpt-6-astra", settings: { effort: "max", fast: true } });
    await provider.complete({ ...request(), model: "gpt-6-astra" });
    expect(bodies[0]).toMatchObject({ reasoning: { summary: "auto", effort: "max" }, service_tier: "priority" });
    expect(bodies[1]).toMatchObject({ reasoning: { summary: "auto" } });
    expect(bodies[1]).not.toHaveProperty("service_tier");
    expect(bodies[1]?.reasoning).not.toHaveProperty("effort");
  });
  test("Codex terminal metadata distinguishes refusal and omitted nontext output for summary safety", async () => {
    const refusal: ResponseOutputItem = { type: "message", id: "refused", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "cannot comply" }] };
    let output: ResponseOutputItem[] = [message, refusal];
    intercept(async () => codexSSE([{ type: "response.completed", response: { status: "completed", output } }]));
    const p = openai(async () => fakeCodexTokens());
    expect(await p.complete(request())).toMatchObject({ completion: "refusal", stop: "refusal" });
    output = [message, { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Checking the directory." }] }];
    expect((await p.complete(request())).completion).toBe("completed");
    output = [reasoning, message]; expect((await p.complete(request())).completion).toBe("completed");
    output = [message, call]; expect((await p.complete(request())).completion).toBe("nontext");
    output = [message]; expect((await p.complete(request())).completion).toBe("completed");
  });

  test("Codex cancellation aborts the HTTP request and never retries it", async () => {
    const ready = Promise.withResolvers<void>();
    let requests = 0, aborted = false;
    intercept(async req => {
      requests++;
      ready.resolve();
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => { aborted = true; reject(req.signal.reason); }, { once: true });
      });
    });
    const controller = new AbortController();
    const result = openai(async () => fakeCodexTokens()).complete({ ...request(), signal: controller.signal });
    await ready.promise;
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(requests).toBe(1);
  });

  test("Codex cancellation aborts a partially consumed stream", async () => {
    let aborted = false;
    intercept(async req => new Response(new ReadableStream({ start(controller) {
      req.signal.addEventListener("abort", () => { aborted = true; controller.error(req.signal.reason); }, { once: true });
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } }));
    const controller = new AbortController();
    const result = openai(async () => fakeCodexTokens()).complete({ ...request(() => controller.abort()), signal: controller.signal });
    await expect(result).rejects.toThrow();
    expect(aborted).toBe(true);
  });


  test("Codex terminal usage retains cached context and optional reasoning metrics", async () => {
    for (const terminal of ["response.completed", "response.done"]) {
      intercept(async () => codexSSE([{ type: terminal, response: { status: "completed", output: [message], usage: {
        input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 },
      } } }]));
      const result = await openai(async () => fakeCodexTokens()).complete(request());
      expect(result.usage).toEqual({ input: 1000, cachedInput: 800, output: 40, reasoning: 30 });
      expect(result.inputTokens).toBe(1000);
      mockFetch?.mockRestore(); mockFetch = undefined;
    }
    intercept(async () => codexSSE([{ type: "response.completed", response: { status: "completed", output: [message] } }]));
    const missing = await openai(async () => fakeCodexTokens()).complete(request());
    expect(missing.usage).toBeUndefined(); expect(missing.inputTokens).toBeUndefined();
  });

  test("cache grouping follows the stable prefix, not changing messages or local trace IDs", async () => {
    const tokens=fakeCodexTokens(),sent:Record<string,unknown>[]=[];
    intercept(async req=>{sent.push(await json(req));return codexSSE([{type:'response.completed',response:{status:'completed',output:[message]}}]);});
    const p=openai(async()=>tokens),base={...request(),system:'stable role'};
    await p.complete({...base,trace:{project:'one',run:'first'}});
    await p.complete({...base,messages:[{role:'user',content:'new assignment'}],trace:{project:'two',run:'second'}});
    await p.complete({...base,system:'changed role'});
    expect(sent[0]?.prompt_cache_key).toBe(sent[1]?.prompt_cache_key);
    expect(sent[2]?.prompt_cache_key).not.toBe(sent[0]?.prompt_cache_key);
    expect(sent[0]).not.toHaveProperty('prompt_cache_options');
    expect(JSON.stringify(sent[0]?.input)).not.toContain('prompt_cache_breakpoint');
  });

  test("Codex cache-write usage is recorded when present and never subtracted from occupied input", async () => {
    intercept(async()=>codexSSE([{type:'response.completed',response:{status:'completed',output:[message],usage:{input_tokens:1000,
      input_tokens_details:{cached_tokens:800,cache_write_tokens:150},output_tokens:40,output_tokens_details:{reasoning_tokens:30}}}}]));
    const turn=await openai(async()=>fakeCodexTokens()).complete(request());
    expect(turn.inputTokens).toBe(1000);
    expect(turn.usage).toEqual({input:1000,cachedInput:800,cacheWriteInput:150,output:40,reasoning:30});
  });

  test("Codex cache affinity uses an opaque session header stable across provider reloads and distinct per transcript", async () => {
    const tokens=fakeCodexTokens(),sent:{body:Record<string,unknown>;session:string|null;thread:string|null}[]=[];
    intercept(async req=>{sent.push({body:await json(req),session:req.headers.get('session-id'),thread:req.headers.get('thread-id')});
      return codexSSE([{type:'response.completed',response:{status:'completed',output:[message]}}]);});
    const base={...request(),system:'stable',cacheScope:'/private/local/transcript-one.jsonl'};
    await openai(async()=>tokens).complete(base);
    await openai(async()=>tokens).complete({...base,messages:[{role:'user',content:'next task'}],trace:{run:'new-run'}});
    await openai(async()=>tokens).complete({...base,cacheScope:'/private/local/transcript-two.jsonl'});
    expect(sent[0]?.session).toMatch(/^[a-f0-9]{64}$/);
    expect(sent[0]?.body).toHaveProperty("prompt_cache_key", sent[0]?.session);
    expect(sent[0]?.thread).toBe(sent[0]?.session);
    expect(sent[1]?.session).toBe(sent[0]?.session);
    expect(sent[2]?.session).not.toBe(sent[0]?.session);
    expect(JSON.stringify(sent)).not.toContain('/private/local');expect(JSON.stringify(sent)).not.toContain('new-run');
  });
});

describe("effort and fast mode in the payload", () => {
  test("Codex explicit effort and Fast map independently to reasoning.effort and service_tier priority", () => {
    expect(codexRequestSettings("gpt-6-astra")).toEqual({ reasoning: { summary: "auto" } });
    expect(codexRequestSettings("gpt-6-astra", { effort: "max", fast: true })).toEqual({ reasoning: { summary: "auto", effort: "max" }, service_tier: "priority" });
    expect(codexRequestSettings("gpt-6-astra", { fast: true })).toEqual({ reasoning: { summary: "auto" }, service_tier: "priority" });
    expect(codexRequestSettings("gpt-6-astra", { effort: "low", fast: false })).toEqual({ reasoning: { summary: "auto", effort: "low" } });
    expect(() => codexRequestSettings("unknown", { fast: true })).toThrow("unsupported");
  });

  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

  test("Claude payload uses output_config.effort and speed, adds beta only to preview fast models", async () => {
    const requests: { body: unknown; headers: Headers }[] = [];
    const client = new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
      const request = (input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      const body: unknown = await request.json();
      requests.push({ body, headers: request.headers });
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    } });
    for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
      await anthropic(client).complete({ model, messages: [{ role: "user", content: "task" }], tools: [], maxTokens: 100, onText() {}, settings: { effort: "high", fast: true } });
    }
    const [first, second, third] = requests;
    expect(first?.body).toHaveProperty("output_config", { effort: "high" });
    expect(first?.body).toHaveProperty("speed", "fast");
    expect(first?.body).not.toHaveProperty("service_tier");
    expect(first?.headers.get("anthropic-beta")).toBeNull();
    expect(second?.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
    expect(third?.headers.get("anthropic-beta")).toContain("oauth");
    expect(claudeRequestSettings("claude-opus-5-5")).toEqual({});
    expect(claudeRequestSettings("claude-opus-5-5", { fast: false })).toEqual({});
    expect(() => claudeRequestSettings("claude-sonnet-4-6", { effort: "xhigh" })).toThrow("unsupported");
  });
});

describe("prompt caching", () => {
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const sentBody = z.object({ system: z.array(z.record(z.string(), z.unknown())), messages: z.unknown(), cache_control: z.unknown().optional() }).loose();

  function client() {
    const sent: unknown[] = [];
    const sdk = new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
      const body: unknown = await (input instanceof Request ? new Request(input, init) : new Request(String(input), init)).json();
      sent.push(body);
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    } });
    return { sent, sdk };
  }
  const body = (sent: unknown[], index: number) => sentBody.parse(sent[index]);
  const request: CompleteRequest = { model: "claude-opus-5-5", system: "Stable instructions", maxTokens: 100,
    settings: { effort: "medium", fast: false }, tools: [], onText() {},
    messages: [{ role: "user", content: "Original task" }, { role: "assistant", content: [{ type: "tool_use", id: "call", name: "bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "workspace" }] }],
  };
  test("opt-in caching adds stable-prefix and moving history boundaries without changing history or generation settings", async () => {
    const normal = client(), cached = client();
    const original = structuredClone(request.messages);
    await anthropic(normal.sdk).complete(request);
    await anthropic(cached.sdk, { promptCache: true }).complete(request);
    const plain = body(normal.sent, 0);
    expect(plain.cache_control).toBeUndefined();
    expect(body(cached.sent, 0)).toEqual({ ...plain, cache_control: { type: "ephemeral" },
      system: plain.system.map((block, i) => i === 1 ? { ...block, cache_control: { type: "ephemeral" } } : block) });
    expect(request.messages).toEqual(original);
  });
  test("cache reads and writes still count in input context, with writes tracked separately", async () => {
    const { sdk } = client();
    const turn = await anthropic(sdk, { promptCache: true }).complete(request);
    expect(turn.inputTokens).toBe(1103);
    expect(turn.usage).toEqual({ input: 1103, cachedInput: 1000, cacheWriteInput: 100, output: 5 });
  });
  test("a replaced compacted history is sent as-is, without retaining a stale manual cache breakpoint", async () => {
    const { sdk, sent } = client(); const p = anthropic(sdk, { promptCache: true });
    await p.complete(request);
    const messages: CompleteRequest["messages"] = [{ role: "user", content: "Summary of prior work" }, { role: "user", content: "Continue the remaining work" }];
    await p.complete({ ...request, messages });
    expect(body(sent, 1).messages).toEqual(messages);
    expect(body(sent, 1).system).toEqual(body(sent, 0).system);
    expect(body(sent, 1).cache_control).toEqual({ type: "ephemeral" });
  });

  test("local cache-routing scope and trace never enter Anthropic model payloads", async () => {
    const { sdk, sent } = client(), p = anthropic(sdk, { promptCache: true });
    await p.complete({ ...request, cacheScope: "/local/one", trace: { run: "one" } });
    await p.complete({ ...request, cacheScope: "/local/two", trace: { run: "two" } });
    expect(sent[1]).toEqual(sent[0]); expect(JSON.stringify(sent)).not.toContain("/local/");
  });
});

describe("switching model mid-conversation", () => {
  const sse = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const sentRequest = z.object({ model: z.string(), messages: z.array(z.unknown()) });
  type SentRequest = z.infer<typeof sentRequest>;

  function recordingClient(requests: SentRequest[]): Anthropic {
    return new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
      const body: unknown = await (input instanceof Request ? new Request(input, init) : new Request(String(input), init)).json();
      requests.push(sentRequest.parse(body));
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    } });
  }

  test("cross-provider history preserves text and paired tool IDs but not foreign reasoning", async () => {
    const messages: MessageParam[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private", signature: JSON.stringify({ provider: "codex", id: "rs_1", encrypted_content: "encrypted" }) },
        { type: "text", text: "context" },
        { type: "tool_use", id: "call_123", name: "echo", input: { text: "hello" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_123", content: "result" }] },
    ];
    const requests: SentRequest[] = [];
    await anthropic(recordingClient(requests)).complete({ model: "claude-test", messages, tools: [], maxTokens: 100, onText() {} });
    const sent = requests[0]?.messages;
    expect(JSON.stringify(sent)).not.toContain("encrypted");
    expect(JSON.stringify(sent)).toContain("context");
    expect(JSON.stringify(sent)).toContain("call_123");
    expect(JSON.stringify(sent)).toContain("result");
    expect(JSON.stringify(messages)).toContain("encrypted");
    const claude: MessageParam[] = [{ role: "assistant", content: [
      { type: "thinking", thinking: "private", signature: "claude-signature" },
      { type: "text", text: "context" },
      { type: "tool_use", id: "toolu_123", name: "echo", input: {} },
    ] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "result" }] }];
    const converted = toResponses(claude);
    expect(JSON.stringify(converted)).not.toContain("claude-signature");
    expect(converted).toContainEqual({ type: "function_call", call_id: "toolu_123", name: "echo", arguments: "{}" });
    expect(converted).toContainEqual({ type: "function_call_output", call_id: "toolu_123", output: "result" });
  });

  test("actual Codex adapter output roundtrips mixed text/caller/multiple error tool pairs", () => {
    const content = fromResponses([
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "secret" },
      { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "working", annotations: [], logprobs: [] }] },
      { type: "function_call", call_id: "call_a", name: "echo", arguments: '{"text":"a"}', status: "completed" },
      { type: "function_call", call_id: "call_b", name: "echo", arguments: '{"text":"b"}', status: "completed" },
    ]);
    const history: MessageParam[] = [{ role: "assistant", content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_a", content: "success" },
      { type: "tool_result", tool_use_id: "call_b", content: "failure", is_error: true },
    ] }];
    const claude = claudeMessages(history);
    expect(claude[0]?.content).toContainEqual({ type: "tool_use", id: "call_a", name: "echo", input: { text: "a" }, caller: { type: "direct" } });
    expect(JSON.stringify(claude)).not.toContain("secret");
    const roundtrip = toResponses(claude);
    expect(roundtrip).toContainEqual({ type: "function_call_output", call_id: "call_a", output: "success" });
    expect(roundtrip).toContainEqual({ type: "function_call_output", call_id: "call_b", output: "Error: failure" });
    expect(roundtrip).toContainEqual({ type: "function_call", call_id: "call_b", name: "echo", arguments: '{"text":"b"}' });
    expect(JSON.stringify(roundtrip)).toContain("working");
    expect(JSON.stringify(history)).toContain("secret");
  });

  test("reasoning-only foreign messages dropped; Claude signed/redacted reasoning preserved across Claude models", async () => {
    const reasoning = fromResponses([{ type: "reasoning", id: "rs_only", summary: [], encrypted_content: "secret" }]);
    const history: MessageParam[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: reasoning },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Claude plan", signature: "claude-signed" },
        { type: "redacted_thinking", data: "opaque-claude-data" },
        { type: "text", text: "response" },
      ] },
    ];
    const sanitized = claudeMessages(history);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[1]).toEqual(history[2]);
    const codex = toResponses(history);
    expect(JSON.stringify(codex)).not.toContain("claude-signed");
    expect(JSON.stringify(codex)).not.toContain("opaque-claude-data");
    expect(codex).toContainEqual({ type: "reasoning", id: "rs_only", summary: [], encrypted_content: "secret" });
    const requests: SentRequest[] = [];
    const client = recordingClient(requests);
    for (const model of ["claude-sonnet-4-6", "claude-opus-5-5"]) {
      await anthropic(client).complete({ model, messages: history, tools: [], maxTokens: 100, onText() {} });
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual(requests[1]?.messages);
  });

  test("an empty Codex reply reaches Claude as nothing: blank text is never recorded or sent (the Messages API refuses it)", async () => {
    const reply = fromResponses([{ type: "reasoning", id: "rs_e", summary: [], encrypted_content: "secret" },
      { type: "message", id: "msg_e", role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] }]);
    expect(reply.map(b => b.type)).toEqual(["thinking"]);
    const history: MessageParam[] = [{ role: "user", content: "task" }, { role: "assistant", content: [...reply, { type: "text", text: "" }] },
      { role: "user", content: "again" }, { role: "assistant", content: [{ type: "text", text: " \n" }, { type: "text", text: "kept" }] }];
    expect(claudeMessages(history)).toEqual([{ role: "user", content: "task" }, { role: "user", content: "again" }, { role: "assistant", content: [{ type: "text", text: "kept" }] }]);
  });

  test("a history ending in a reply that never came (reasoning only) is not sent as a prefill; blank Claude text never reaches Codex", async () => {
    const history: MessageParam[] = [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "text", text: "on it" }] },
      { role: "user", content: [] }, { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "claude-signed" }] }];
    expect(claudeMessages(history)).toEqual(history.slice(0, 2));
    const codex = toResponses([{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "kept" }] }]);
    expect(codex.filter(item => "role" in item && item.role === "assistant")).toHaveLength(1);
  });
});

describe("usage accounting", () => {
  const logLine = z.object({ kind: z.string() });
  const parseLine = (line: string): unknown => JSON.parse(line);
  let home = "", prior: string | undefined;
  afterEach(async () => { if (prior === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = prior; if (home !== "") await rm(home, { recursive: true, force: true }); });
  test("accounting includes foreground, summaries, tools, search and retries without recording payloads", async () => {
    prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-")); process.env.ORCA2_HOME = home;
    const fake = fakeProvider([[text("private response")]]), original = fake.complete;
    fake.complete = async request => { recordRetry("anthropic", { attempt: 1, reason: "timeout" }); return { ...await original(request), inputTokens: 100, usage: { input: 100, cachedInput: 40, output: 10 } }; };
    const provider = metered({ ...fake, search: async () => ({ sources: [] }) });
    await provider.complete({ trace: { project: "p", agent: "orchestrator", purpose: "rolling-summary" }, model: "test", messages: [{ role: "user", content: "private prompt" }], tools: [], maxTokens: 10, onText() {} });
    const search = provider.search;
    if (search === undefined) throw new Error("metered provider lost search");
    await usageScope({ project: "p", agent: "worker-x" }, () => search({ model: "test", query: "private query", maxResults: 1, signal: new AbortController().signal }));
    await usageEvent({ kind: "tool", project: "p", tool: "read", durationMs: 5 });
    const log = await readFile(join(home, "usage.jsonl"), "utf8");
    const kinds = log.trim().split("\n").map(line => logLine.parse(parseLine(line)).kind);
    expect(kinds.filter(kind => kind === "model").length).toBe(2);
    expect(kinds).toContain("retry");
    const model = z.object({ build: z.string(), toolCalls: z.literal(0) }).safeParse(parseLine(log.trim().split("\n").find(line => line.includes('"kind":"model"')) ?? "null"));
    expect(model.success).toBe(true);
    expect(log).not.toContain("private"); expect(log).toContain("rolling-summary"); expect(log).toContain("web-search");
  });

  test("failure diagnostics identify the selected account and HTTP status without exposing payloads", async () => {
    prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-error-")); process.env.ORCA2_HOME = home;
    const provider = metered({ ...fakeProvider([]), account: "anthropic:personal", complete: async () => { throw new ModelRequestError("exhausted", 429); } });
    await expect(provider.complete({ model: "test", messages: [], tools: [], maxTokens: 10, onText() {} })).rejects.toThrow("anthropic:personal: Provider rate limit");
    const events = (await readFile(join(home, "usage.jsonl"), "utf8")).trim().split("\n").map(parseLine);
    expect(events[0]).toMatchObject({ account: "anthropic:personal", errorKind: "exhausted", errorReason: "rate-limit", httpStatus: 429, ok: false });
  });

  test("account-specific authentication guidance survives metering", async () => {
    prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-auth-")); process.env.ORCA2_HOME = home;
    const provider = metered({ ...fakeProvider([]), account: "openai:work", complete: async () => { throw new ModelRequestError("permanent", 401, "authentication"); } });
    await expect(provider.complete({ model: "test", messages: [], tools: [], maxTokens: 10, onText() {} })).rejects.toThrow("Sign in again with: orca2 login openai work");
  });
});
