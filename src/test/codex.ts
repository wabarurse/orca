import type { CodexTokens } from "../codex-auth";

/** Deliberately unsigned test token. Never valid against a real service. */
export function fakeCodexTokens(accountId = "test-account", expiresAt = Date.now() + 3_600_000, marker = "test"): CodexTokens {
  const payload = { exp: Math.floor(expiresAt / 1000), marker, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return { accessToken: `test.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`,
    refreshToken: "test-refresh", expiresAt, accountId };
}

export function codexSSE(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
