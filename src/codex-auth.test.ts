import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL, codexCredentials, codexCredentialsPath, importCodex, loginCodex, readCodexTokens, saveCodexTokens } from "./codex-auth";
import { fakeCodexTokens } from "./test/codex";

let home: string;
let originalHome: string | undefined;
beforeEach(() => {
  originalHome = process.env.ORCA_HOME;
  home = mkdtempSync(join(tmpdir(), "orca-codex-"));
  process.env.ORCA_HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.ORCA_HOME;
  else process.env.ORCA_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function expectShortLink(output: string, port: string, full: string, file: string) {
  const link = output.match(/http:\/\/localhost:\d+\/login\/[\w-]+/)?.[0];
  expect(link).toBeDefined();
  expect(link!.length).toBeLessThan(50);
  expect(output).not.toContain(full);
  expect(output).toContain(file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8").trim()).toBe(full);
  const short = new URL(link!);
  short.hostname = "127.0.0.1";
  expect(short.port).toBe(port);
  const redirect = await fetch(short, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe(full);
  short.pathname = "/login/wrong";
  expect((await fetch(short, { redirect: "manual" })).status).toBe(404);
}

test("Codex browser login uses its public client ID, PKCE and form token exchange", async () => {
  const tokens = fakeCodexTokens();
  let authorization: URL;
  let callback: Promise<void> | undefined;
  let output = "";
  await loginCodex("personal", {
    port: 0, write(text) { output += text; },
    openBrowser(url) {
      authorization = new URL(url);
      callback = (async () => {
        expect(authorization.origin + authorization.pathname).toBe("https://auth.openai.com/oauth/authorize");
        expect(authorization.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
        expect(authorization.searchParams.get("originator")).toBe("codex_cli_rs");
        expect(authorization.searchParams.get("codex_cli_simplified_flow")).toBe("true");
        expect(authorization.searchParams.get("scope")).toContain("offline_access");
        const target = new URL(authorization.searchParams.get("redirect_uri")!);
        expect(target.pathname).toBe("/auth/callback");
        target.hostname = "127.0.0.1";
        await expectShortLink(output, target.port, authorization.toString(), join(home, "login-url.txt"));
        target.search = new URLSearchParams({ code: "test-code", state: "wrong" }).toString();
        expect((await fetch(target)).status).toBe(400);
        expect(await readCodexTokens("personal")).toBeNull();
        target.searchParams.set("state", authorization.searchParams.get("state")!);
        expect((await fetch(target)).status).toBe(200);
      })();
    },
    async fetcher(url, init) {
      expect(url).toBe(CODEX_TOKEN_URL);
      expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
      expect(body.get("code")).toBe("test-code");
      expect(body.get("state")).toBe(authorization.searchParams.get("state"));
      expect(body.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge")!);
      expect(init.redirect).toBe("error");
      return Response.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_in: 3600 });
    },
  });
  await callback;
  expect((await readCodexTokens("personal"))?.accountId).toBe("test-account");
  expect(statSync(codexCredentialsPath("personal")).mode & 0o777).toBe(0o600);
  expect(output).not.toContain(tokens.accessToken);
  expect(output).not.toContain(tokens.refreshToken);
  expect(existsSync(join(home, "login-url.txt"))).toBe(false);
});

test("Codex refresh is serialized and persists rotated tokens and account routing", async () => {
  await saveCodexTokens("default", fakeCodexTokens("test-account", Date.now() - 1000));
  const next = fakeCodexTokens("test-account", Date.now() + 3_600_000, "new");
  let refreshes = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    refreshes++;
    expect(url).toBe(CODEX_TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: "test-refresh" });
    await Bun.sleep(20);
    return Response.json({ access_token: next.accessToken, refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  const results = await Promise.all([codexCredentials("default", fetcher)(), codexCredentials("default", fetcher)()]);
  expect(refreshes).toBe(1);
  expect(results.map((result) => result.accessToken)).toEqual([next.accessToken, next.accessToken]);
  expect((await readCodexTokens("default"))?.refreshToken).toBe("rotated-refresh");
});

test("Codex forced refresh reuses another client's rotation and retains omitted refresh tokens", async () => {
  await saveCodexTokens("default", fakeCodexTokens());
  const next = fakeCodexTokens("test-account", Date.now() + 3_600_000, "new");
  let refreshes = 0;
  const credentials = codexCredentials("default", async () => {
    refreshes++;
    return Response.json({ access_token: next.accessToken, expires_in: 3600 });
  });
  await credentials();
  await saveCodexTokens("default", next);
  expect((await credentials({ forceRefresh: true })).accessToken).toBe(next.accessToken);
  expect(refreshes).toBe(0);
  await credentials({ forceRefresh: true });
  expect(refreshes).toBe(1);
  expect((await readCodexTokens("default"))?.refreshToken).toBe("test-refresh");
});

test("Codex refresh failures cannot change accounts or destroy the previous login", async () => {
  const previous = fakeCodexTokens("test-account", Date.now() - 1000);
  await saveCodexTokens("default", previous);
  const wrongAccount = fakeCodexTokens("another-account");
  for (const response of [
    new Response("private-token", { status: 401 }),
    Response.json({ access_token: "not-a-subscription-token", expires_in: 60 }),
    Response.json({ access_token: wrongAccount.accessToken, expires_in: 3600 }),
    Response.json({ access_token: previous.accessToken, expires_in: -1 }),
  ]) {
    try {
      await codexCredentials("default", async () => response)();
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("codex oauth");
      expect(String(error)).not.toContain("private-token");
    }
    expect(await readCodexTokens("default")).toEqual(previous);
  }
});

test("Codex import accepts native ChatGPT tokens and rejects API-key-only auth", async () => {
  const file = join(home, "native-auth.json");
  const tokens = fakeCodexTokens();
  const data = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: tokens.accessToken, refresh_token: tokens.refreshToken, account_id: tokens.accountId } });
  await Bun.write(file, data);
  await importCodex("personal", file);
  expect((await readCodexTokens("personal"))?.accessToken).toBe(tokens.accessToken);
  expect(await Bun.file(file).text()).toBe(data);
  await Bun.write(file, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "unused-key" }));
  await expect(importCodex("api", file)).rejects.toThrow("chatgpt subscription login");
  expect(await readCodexTokens("api")).toBeNull();
});

test("Codex cancellation leaves the old profile intact", async () => {
  const tokens = fakeCodexTokens();
  await saveCodexTokens("personal", tokens);
  const abort = new AbortController();
  await expect(loginCodex("personal", {
    port: 0, signal: abort.signal, write() {}, openBrowser() { abort.abort(); },
  })).rejects.toThrow("cancelled");
  expect(await readCodexTokens("personal")).toEqual(tokens);
});
