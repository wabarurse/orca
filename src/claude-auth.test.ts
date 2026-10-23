import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, claudeCredentials, claudeCredentialsPath,
  claudeProfiles, importClaudeCode, loginClaude, readClaudeTokens, saveClaudeTokens,
} from "./claude-auth";

let home: string;
let previousHome: string | undefined;
let previousClaude: string | undefined;
beforeEach(() => {
  previousHome = process.env.PARALLELS_HOME;
  previousClaude = process.env.CLAUDE_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "parallels-claude-auth-"));
  process.env.PARALLELS_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.PARALLELS_HOME;
  else process.env.PARALLELS_HOME = previousHome;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  rmSync(home, { recursive: true, force: true });
});

const fresh = () => ({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 });
const tokenResponse = (access = "new-access", refresh: string | undefined = "new-refresh") => Response.json({
  access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer",
});

test("browser OAuth validates state and exchanges a PKCE code for private, named credentials", async () => {
  let authorization: URL;
  let callback: Promise<void> | undefined;
  let written = "";
  const login = loginClaude("personal", {
    port: 0,
    write: (text) => { written += text; },
    openBrowser(url) {
      authorization = new URL(url);
      callback = (async () => {
        expect(authorization.origin + authorization.pathname).toBe("https://claude.ai/oauth/authorize");
        expect(authorization.searchParams.get("client_id")).toBe(CLAUDE_CLIENT_ID);
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("scope")).toContain("user:inference");
        const target = new URL(authorization.searchParams.get("redirect_uri")!);
        target.hostname = "127.0.0.1";
        target.search = new URLSearchParams({ code: "test-code", state: "wrong-state" }).toString();
        expect((await fetch(target)).status).toBe(400);
        expect(await readClaudeTokens("personal")).toBeNull();
        target.searchParams.set("state", authorization.searchParams.get("state")!);
        const response = await fetch(target);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("signed in");
      })();
    },
    async fetcher(url, init) {
      expect(url).toBe(CLAUDE_TOKEN_URL);
      const body = JSON.parse(init.body as string);
      expect(body.client_id).toBe(CLAUDE_CLIENT_ID);
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("test-code");
      expect(body.state).toBe(authorization.searchParams.get("state"));
      expect(body.redirect_uri).toBe(authorization.searchParams.get("redirect_uri"));
      expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(authorization.searchParams.get("code_challenge")!);
      expect(init.redirect).toBe("error");
      return tokenResponse();
    },
  });
  await login;
  await callback;
  expect((await readClaudeTokens("personal"))?.refreshToken).toBe("new-refresh");
  expect(claudeProfiles()).toEqual(["personal"]);
  expect(statSync(claudeCredentialsPath("personal")).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, "auth", "anthropic")).mode & 0o777).toBe(0o700);
  expect(written).not.toContain("new-access");
  expect(written).not.toContain("new-refresh");
});

test("cancelled login releases its callback port and saves nothing", async () => {
  const abort = new AbortController();
  let port = 0;
  await expect(loginClaude("default", {
    port: 0, signal: abort.signal, write() {},
    openBrowser(url) {
      port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port);
      abort.abort();
    },
  })).rejects.toThrow("cancelled");
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  await server.stop(true);
  expect(claudeProfiles()).toEqual([]);
});

test("cancelling a code exchange aborts the request and preserves the previous login", async () => {
  const original = fresh();
  await saveClaudeTokens("default", original);
  const abort = new AbortController();
  let callback: Promise<Response> | undefined;
  let exchangeAborted = false;
  await expect(loginClaude("default", {
    port: 0, signal: abort.signal, write() {},
    openBrowser(url) {
      const authorization = new URL(url);
      const target = new URL(authorization.searchParams.get("redirect_uri")!);
      target.hostname = "127.0.0.1";
      target.search = new URLSearchParams({ code: "code", state: authorization.searchParams.get("state")! }).toString();
      callback = fetch(target);
    },
    async fetcher(_, init) {
      const pending = new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () => { exchangeAborted = true; reject(new Error("aborted")); }, { once: true });
      });
      abort.abort();
      return pending;
    },
  })).rejects.toThrow("cancelled");
  expect((await callback)!.status).toBe(400);
  expect(exchangeAborted).toBe(true);
  expect(await readClaudeTokens("default")).toEqual(original);
});

test("denied browser authorization leaves the existing profile untouched", async () => {
  const original = fresh();
  await saveClaudeTokens("default", original);
  let callback: Promise<Response> | undefined;
  let exchanges = 0;
  await expect(loginClaude("default", {
    port: 0, write() {},
    openBrowser(url) {
      const authorization = new URL(url);
      const target = new URL(authorization.searchParams.get("redirect_uri")!);
      target.hostname = "127.0.0.1";
      target.search = new URLSearchParams({ error: "access_denied", state: authorization.searchParams.get("state")! }).toString();
      callback = fetch(target);
    },
    async fetcher() { exchanges++; return tokenResponse(); },
  })).rejects.toThrow("cancelled or denied");
  expect((await callback)!.status).toBe(400);
  expect(exchanges).toBe(0);
  expect(await readClaudeTokens("default")).toEqual(original);
});

test("tokens refresh once across competing clients and preserve rotated refresh tokens", async () => {
  await saveClaudeTokens("default", { ...fresh(), expiresAt: Date.now() - 1000 });
  let calls = 0;
  const fetcher = async (_: string, init: RequestInit) => {
    calls++;
    expect(JSON.parse(init.body as string)).toEqual({ client_id: CLAUDE_CLIENT_ID, grant_type: "refresh_token", refresh_token: "test-refresh" });
    await Bun.sleep(20);
    return tokenResponse();
  };
  const [one, two] = await Promise.all([claudeCredentials("default", fetcher)(), claudeCredentials("default", fetcher)()]);
  expect(calls).toBe(1);
  expect(one.token).toBe("new-access");
  expect(two.token).toBe("new-access");
  expect((await readClaudeTokens("default"))?.refreshToken).toBe("new-refresh");
});

test("refresh is serialized between independent worker processes", async () => {
  await saveClaudeTokens("workers", { ...fresh(), expiresAt: Date.now() - 1000 });
  const script = join(home, "worker.ts");
  await Bun.write(script, `
    import { claudeCredentials } from ${JSON.stringify(join(import.meta.dir, "claude-auth.ts"))};
    const credentials = claudeCredentials("workers", async () => {
      await Bun.write(process.env.PARALLELS_HOME + "/refresh-" + process.pid, "called");
      await Bun.sleep(100);
      return Response.json({ access_token: "worker-access", refresh_token: "worker-refresh", expires_in: 3600 });
    });
    const result = await credentials();
    if (result.token !== "worker-access") process.exit(1);
  `);
  const workers = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, script], {
    env: { ...process.env, PARALLELS_HOME: home }, stdout: "pipe", stderr: "pipe",
  }));
  const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
  expect(errors).toEqual(["", "", ""]);
  expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0, 0]);
  const files = await Array.fromAsync(new Bun.Glob("refresh-*").scan(home));
  expect(files).toHaveLength(1);
  expect((await readClaudeTokens("workers"))?.refreshToken).toBe("worker-refresh");
});

test("forced refresh reuses another client's rotation and retains refresh token when omitted", async () => {
  await saveClaudeTokens("default", fresh());
  let calls = 0;
  const credentials = claudeCredentials("default", async () => { calls++; return Response.json({ access_token: "refreshed", expires_in: 3600 }); });
  expect((await credentials()).token).toBe("test-access");
  await saveClaudeTokens("default", { ...fresh(), accessToken: "other-client" });
  expect((await credentials({ forceRefresh: true })).token).toBe("other-client");
  expect(calls).toBe(0);
  expect((await credentials({ forceRefresh: true })).token).toBe("refreshed");
  expect(calls).toBe(1);
  expect((await readClaudeTokens("default"))?.refreshToken).toBe("test-refresh");
});

test("failed refresh preserves saved tokens, releases the lock, and does not expose secrets", async () => {
  const original = { ...fresh(), expiresAt: Date.now() - 1000 };
  await saveClaudeTokens("default", original);
  const rejected = claudeCredentials("default", async () => new Response("test-refresh test-access", { status: 401 }));
  await expect(rejected()).rejects.toThrow("http 401");
  try { await rejected(); } catch (err) {
    expect(String(err)).not.toContain("test-refresh");
    expect(String(err)).not.toContain("test-access");
  }
  expect(await readClaudeTokens("default")).toEqual(original);
  expect((await claudeCredentials("default", async () => tokenResponse())()).token).toBe("new-access");
});

test("malformed token responses cannot overwrite a valid credential store", async () => {
  const original = { ...fresh(), expiresAt: Date.now() - 1000 };
  await saveClaudeTokens("default", original);
  for (const response of [new Response("bad json"), Response.json({ access_token: "x", expires_in: -1 }), Response.json({ expires_in: 60 })]) {
    await expect(claudeCredentials("default", async () => response)()).rejects.toThrow("invalid credentials");
    expect(await readClaudeTokens("default")).toEqual(original);
  }
});

test("Claude Code import copies credentials without changing the source or other profiles", async () => {
  const source = join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
  const data = JSON.stringify({ claudeAiOauth: fresh() });
  await Bun.write(source, data);
  await saveClaudeTokens("work", { ...fresh(), accessToken: "work-access" });
  await importClaudeCode("personal");
  expect((await readClaudeTokens("personal"))?.accessToken).toBe("test-access");
  expect((await readClaudeTokens("work"))?.accessToken).toBe("work-access");
  expect(await Bun.file(source).text()).toBe(data);
  expect(claudeProfiles()).toEqual(["personal", "work"]);
});

test("missing, invalid and unsafe profiles fail without reading developer-platform credentials", async () => {
  await expect(claudeCredentials("missing")()).rejects.toThrow("not signed in");
  await expect(importClaudeCode("missing")).rejects.toThrow("no claude code login");
  for (const name of ["../outside", "a/b", "", "env", "x".repeat(65)]) {
    await expect(saveClaudeTokens(name, fresh())).rejects.toThrow("profile must");
  }
  await Bun.write(claudeCredentialsPath("invalid"), "not JSON");
  await expect(readClaudeTokens("invalid")).rejects.toThrow("invalid");
});
