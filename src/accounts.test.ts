import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts, provider } from "./accounts";
import { CLAUDE_BETAS, CLAUDE_TOKEN_URL, saveClaudeTokens } from "./claude-auth";
import { saveConfig } from "./config";

const keys = ["PARALLELS_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"];
let original: Record<string, string | undefined>;
let home: string;
let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "parallels-accounts-"));
  process.env.PARALLELS_HOME = home;
  process.env.ANTHROPIC_CONFIG_DIR = join(home, "ant");
});
afterEach(() => {
  mockFetch?.mockRestore();
  mockFetch = undefined;
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  rmSync(home, { recursive: true, force: true });
});

async function saveProfile(name: string, token = "subscription-access") {
  await saveClaudeTokens(name, { accessToken: token, refreshToken: "subscription-refresh", expiresAt: Date.now() + 3_600_000 });
}

function streamResponse(): Response {
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "bash", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const turn = (onText = (_: string) => {}) => ({
  model: "claude-test", messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "bash", input_schema: { type: "object" as const, properties: { command: { type: "string" } } } }],
  maxTokens: 100, onText,
});

function interceptFetch(handler: (request: Request) => Promise<Response>) {
  mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const options = init as RequestInit | undefined;
      return handler(input instanceof Request ? new Request(input, options) : new Request(String(input), options));
    },
    { preconnect: fetch.preconnect },
  ));
}

test("subscription requests use Bearer auth, Claude Code compatibility, streaming tools and model discovery", async () => {
  await saveProfile("personal");
  await saveConfig({ account: "personal" });
  // None of the SDK's implicit developer-platform settings may override a subscription.
  process.env.ANTHROPIC_AUTH_TOKEN = "wrong-platform-token";
  process.env.ANTHROPIC_PROFILE = "wrong-profile";
  process.env.ANTHROPIC_BASE_URL = "https://wrong.example";
  const requests: Request[] = [];
  interceptFetch(async (request) => {
    requests.push(request);
    if (request.url.endsWith("/v1/models")) return Response.json({ data: [{ id: "claude-test", type: "model", display_name: "Test", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-test", last_id: "claude-test" });
    return streamResponse();
  });
  const client = await provider("anthropic");
  let text = "";
  const req = turn((delta) => { text += delta; });
  const result = await client.complete(req);
  expect(text).toBe("hello");
  expect(result.stop).toBe("tool_use");
  expect(result.content[1]).toMatchObject({ type: "tool_use", name: "bash", id: "tool_1", input: { command: "pwd" } });
  expect(await client.models()).toEqual(["claude-test"]);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe("https://api.anthropic.com");
    expect(request.headers.get("authorization")).toBe("Bearer subscription-access");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("anthropic-beta")).toBe(CLAUDE_BETAS);
  }
  const body = await requests[0]!.json() as Record<string, unknown>;
  expect(body.system).toEqual([{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
  expect(body.messages).toEqual(req.messages);
  expect(body.tools).toEqual(req.tools);
  expect(body.stream).toBe(true);
  expect(req).not.toHaveProperty("system");
});

test("API-key override is explicit in account listing and never sends subscription headers or identity", async () => {
  await saveProfile("personal");
  await saveConfig({ account: "personal" });
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.ANTHROPIC_AUTH_TOKEN = "unused-token";
  let request: Request | undefined;
  interceptFetch(async (incoming) => {
    request = incoming;
    return streamResponse();
  });
  const listed = await accounts();
  expect(listed.find((a) => a.id === "anthropic:env")).toMatchObject({ active: true, source: expect.stringContaining("API billing") });
  expect(listed.find((a) => a.id === "anthropic:personal")?.active).toBe(false);
  await (await provider("anthropic")).complete(turn());
  expect(request!.headers.get("x-api-key")).toBe("test-api-key");
  expect(request!.headers.get("authorization")).toBeNull();
  expect(request!.headers.get("anthropic-beta")).toBeNull();
  expect(await request!.json()).not.toHaveProperty("system");
});

test("a 401 refreshes the subscription token once and retries with the rotated token", async () => {
  await saveProfile("default");
  const authorizations: (string | null)[] = [];
  let refreshes = 0;
  interceptFetch(async (request) => {
    if (request.url === CLAUDE_TOKEN_URL) {
      refreshes++;
      expect(await request.json()).toMatchObject({ grant_type: "refresh_token", refresh_token: "subscription-refresh" });
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    }
    authorizations.push(request.headers.get("authorization"));
    if (authorizations.length === 1) return Response.json({ type: "error", error: { type: "authentication_error", message: "Expired" } }, { status: 401 });
    return streamResponse();
  });
  await (await provider("anthropic")).complete(turn());
  expect(refreshes).toBe(1);
  expect(authorizations).toEqual(["Bearer subscription-access", "Bearer rotated-access"]);
});

test("profile switching updates credentials; missing selection cannot fall back to ant or another subscription", async () => {
  await saveProfile("one", "account-one");
  await saveProfile("two", "account-two");
  const used: (string | null)[] = [];
  interceptFetch(async (request) => {
    used.push(request.headers.get("authorization"));
    return streamResponse();
  });
  await saveConfig({ account: "one" });
  const first = await provider("anthropic");
  await saveConfig({ account: "two" });
  await first.complete(turn());
  await (await provider("anthropic")).complete(turn());
  expect(used).toEqual(["Bearer account-one", "Bearer account-two"]);
  expect((await accounts()).find((a) => a.id === "anthropic:two")?.active).toBe(true);
  await saveConfig({ account: "legacy" });
  await Bun.write(join(process.env.ANTHROPIC_CONFIG_DIR!, "credentials", "legacy.json"), JSON.stringify({ access_token: "platform-token" }));
  await expect(provider("anthropic")).rejects.toThrow("not signed in");
  expect((await accounts()).find((a) => a.id === "anthropic:legacy")).toMatchObject({ ok: false, active: false });
  expect(used).toHaveLength(2);
});
