import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeCodexTokens } from "../../test/codex";
import { provider as loadProvider } from "../account";
import { CLAUDE_BETAS } from "../anthropic";
import { clearCatalogEfforts, modelCapabilities } from "../model/capabilities";
import type { CompleteRequest, Provider } from "../provider";
import { accounts, type ProviderName } from "./accounts";
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, claudeCredentials, claudeCredentialsPath, claudeProfiles, importClaudeCode, loginClaude, readClaudeTokens, saveClaudeTokens } from "./claude";
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL, codexCredentials, codexCredentialsPath, importCodex, loginCodex, readCodexTokens, saveCodexTokens } from "./codex";
import { parseLogin } from "./login";
import { breakStaleLock, withCredentialLock } from "./oauth";

describe("/login arguments", () => {
  const accepted: [string[], { provider: ProviderName; profile: string; imported: boolean }][] = [
    [["anthropic"], { provider: "anthropic", profile: "default", imported: false }],
    [["codex", "work", "--import"], { provider: "openai", profile: "work", imported: true }],
    [["claude", "--from-claude-code"], { provider: "anthropic", profile: "default", imported: true }],
  ];
  const refused: string[][] = [[], ["gemini"], ["openai", "a", "b"], ["openai", "--force"], ["openai", "--import", "--import"]];

  test.each(accepted)("parseLogin takes a provider (or its alias), an optional profile and one import flag: %p", (args, data) => {
    expect(parseLogin(args)).toEqual({ ok: true, data });
  });

  test.each(refused.map(args => [args]))("parseLogin refuses %p", args => {
    expect(parseLogin(args).ok).toBe(false);
  });
});

describe("the OAuth sign-in flow", () => {
  const temps: string[] = [];
  afterEach(async () => { for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true }); });

  async function workdir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orca-lock-"));
    temps.push(dir);
    return dir;
  }

  async function deadPid(): Promise<number> {
    const p = Bun.spawn(["true"]);
    await p.exited;
    return p.pid;
  }

  async function placeLock(lock: string, pid: number | null): Promise<void> {
    await mkdir(lock, { recursive: true, mode: 0o700 });
    if (pid !== null) await writeFile(join(lock, "pid"), String(pid));
  }

  test("breakStaleLock removes a lock whose owner pid is dead", async () => {
    const lock = join(await workdir(), "cred.json.lock");
    await placeLock(lock, await deadPid());
    expect(await breakStaleLock(lock)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("breakStaleLock leaves a live owner's lock alone", async () => {
    const lock = join(await workdir(), "cred.json.lock");
    await placeLock(lock, process.pid);
    expect(await breakStaleLock(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  test("breakStaleLock leaves a lock with no pid file (mid-acquisition) alone", async () => {
    const lock = join(await workdir(), "cred.json.lock");
    await placeLock(lock, null);
    expect(await breakStaleLock(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  test("withCredentialLock breaks a stale lock and runs the action", async () => {
    const path = join(await workdir(), "cred.json");
    await placeLock(`${path}.lock`, await deadPid());
    let ran = false;
    const result = await withCredentialLock(path, async () => { ran = true; return 42; });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("withCredentialLock serializes two callers on the same path", async () => {
    const path = join(await workdir(), "cred.json");
    const order: string[] = [];
    const entered = Promise.withResolvers<void>();
    const first = withCredentialLock(path, async () => { order.push("a-start"); entered.resolve(); await Bun.sleep(30); order.push("a-end"); });
    await entered.promise;
    const second = withCredentialLock(path, async () => { order.push("b"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});

describe("Claude credentials", () => {
  const refused = (result: { ok: true; data: null } | { ok: false; error: string }): string => result.ok ? "" : result.error;
  function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("missing test value");
    return value;
  }
  const bodyText = (body: RequestInit["body"]): string => typeof body === "string" ? body : "";
  const parseJSON = (text: string): unknown => JSON.parse(text);

  let home: string;
  let previousHome: string | undefined;
  let previousClaude: string | undefined;
  beforeEach(() => {
    previousHome = process.env.ORCA2_HOME;
    previousClaude = process.env.CLAUDE_CONFIG_DIR;
    home = mkdtempSync(join(tmpdir(), "orca-claude-auth-"));
    process.env.ORCA2_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.ORCA2_HOME;
    else process.env.ORCA2_HOME = previousHome;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    rmSync(home, { recursive: true, force: true });
  });

  const fresh = () => ({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 });
  const tokenResponse = (access = "new-access", refresh: string | undefined = "new-refresh") => Response.json({
    access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer",
  });

  async function expectShortLink(output: string, port: string, full: string, file: string) {
    const link = output.match(/http:\/\/localhost:\d+\/login\/[\w-]+/)?.[0];
    expect(link).toBeDefined();
    expect(required(link).length).toBeLessThan(50);
    expect(output).not.toContain(full);
    expect(output).toContain(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(full);
    const short = new URL(required(link));
    short.hostname = "127.0.0.1";
    expect(short.port).toBe(port);
    const redirect = await fetch(short, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(full);
    short.pathname = "/login/wrong";
    expect((await fetch(short, { redirect: "manual" })).status).toBe(404);
  }

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
          const target = new URL(required(authorization.searchParams.get("redirect_uri")));
          target.hostname = "127.0.0.1";
          await expectShortLink(written, target.port, authorization.toString(), join(home, ".runtime", "login-url.txt"));
          target.search = new URLSearchParams({ code: "test-code", state: "wrong-state" }).toString();
          expect((await fetch(target)).status).toBe(400);
          expect(await readClaudeTokens("personal")).toBeNull();
          target.searchParams.set("state", required(authorization.searchParams.get("state")));
          const response = await fetch(target);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("signed in");
        })();
      },
      async fetcher(url, init) {
        expect(url).toBe(CLAUDE_TOKEN_URL);
        const body = z.record(z.string(), z.unknown()).parse(JSON.parse(bodyText(init.body)));
        expect(body.client_id).toBe(CLAUDE_CLIENT_ID);
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("test-code");
        expect(body.state).toBe(authorization.searchParams.get("state"));
        expect(body.redirect_uri).toBe(authorization.searchParams.get("redirect_uri"));
        expect(createHash("sha256").update(String(body.code_verifier)).digest("base64url")).toBe(required(authorization.searchParams.get("code_challenge")));
        expect(init.redirect).toBe("error");
        return tokenResponse();
      },
    });
    expect(await login).toEqual({ ok: true, data: null });
    await callback;
    expect((await readClaudeTokens("personal"))?.refreshToken).toBe("new-refresh");
    expect(claudeProfiles()).toEqual(["personal"]);
    expect(statSync(claudeCredentialsPath("personal")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".runtime", "auth", "anthropic")).mode & 0o777).toBe(0o700);
    expect(written).not.toContain("new-access");
    expect(written).not.toContain("new-refresh");
    expect(written).not.toContain("code_challenge");
    expect(existsSync(join(home, ".runtime", "login-url.txt"))).toBe(false);
  });

  test("cancelled login releases its callback port and saves nothing", async () => {
    const abort = new AbortController();
    let port = 0;
    expect(refused(await loginClaude("default", {
      port: 0, signal: abort.signal, write() {},
      openBrowser(url) {
        port = Number(new URL(required(new URL(url).searchParams.get("redirect_uri"))).port);
        abort.abort();
      },
    }))).toContain("cancelled");
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    await server.stop(true);
    expect(claudeProfiles()).toEqual([]);
  });

  test("login prints an ssh tunnel hint only over ssh and removes the URL file when cancelled", async () => {
    const saved = { c: process.env.SSH_CONNECTION, t: process.env.SSH_TTY };
    try {
      for (const ssh of [false, true]) {
        delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
        if (ssh) process.env.SSH_CONNECTION = "1.2.3.4 5 6.7.8.9 22";
        const abort = new AbortController();
        let written = "";
        expect(refused(await loginClaude("default", {
          port: 0, signal: abort.signal, write(text) { written += text; },
          openBrowser() { abort.abort(); },
        }))).toContain("cancelled");
        expect(written.includes("ssh -L")).toBe(ssh);
        expect(existsSync(join(home, ".runtime", "login-url.txt"))).toBe(false);
      }
    } finally {
      if (saved.c === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = saved.c;
      if (saved.t === undefined) delete process.env.SSH_TTY; else process.env.SSH_TTY = saved.t;
    }
  });

  test("login still works with just the short link when the URL file cannot be written", async () => {
    mkdirSync(join(home, ".runtime", "login-url.txt"), { recursive: true });
    const abort = new AbortController();
    let written = "";
    expect(refused(await loginClaude("default", {
      port: 0, signal: abort.signal, write(text) { written += text; },
      openBrowser() { abort.abort(); },
    }))).toContain("cancelled");
    expect(written).toMatch(/http:\/\/localhost:\d+\/login\//);
    expect(written).not.toContain("login-url.txt");
    expect(statSync(join(home, ".runtime", "login-url.txt")).isDirectory()).toBe(true);
  });

  test("cancelling a code exchange aborts the request and preserves the previous login", async () => {
    const original = fresh();
    await saveClaudeTokens("default", original);
    const abort = new AbortController();
    let callback: Promise<Response> | undefined;
    let exchangeAborted = false;
    expect(refused(await loginClaude("default", {
      port: 0, signal: abort.signal, write() {},
      openBrowser(url) {
        const authorization = new URL(url);
        const target = new URL(required(authorization.searchParams.get("redirect_uri")));
        target.hostname = "127.0.0.1";
        target.search = new URLSearchParams({ code: "code", state: required(authorization.searchParams.get("state")) }).toString();
        callback = fetch(target);
      },
      async fetcher(_, init) {
        const pending = new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => { exchangeAborted = true; reject(new Error("aborted")); }, { once: true });
        });
        abort.abort();
        return pending;
      },
    }))).toContain("cancelled");
    expect(required(await callback).status).toBe(400);
    expect(exchangeAborted).toBe(true);
    expect(await readClaudeTokens("default")).toEqual(original);
  });

  test("denied browser authorization leaves the existing profile untouched", async () => {
    const original = fresh();
    await saveClaudeTokens("default", original);
    let callback: Promise<Response> | undefined;
    let exchanges = 0;
    expect(refused(await loginClaude("default", {
      port: 0, write() {},
      openBrowser(url) {
        const authorization = new URL(url);
        const target = new URL(required(authorization.searchParams.get("redirect_uri")));
        target.hostname = "127.0.0.1";
        target.search = new URLSearchParams({ error: "access_denied", state: required(authorization.searchParams.get("state")) }).toString();
        callback = fetch(target);
      },
      async fetcher() { exchanges++; return tokenResponse(); },
    }))).toContain("cancelled or denied");
    expect(required(await callback).status).toBe(400);
    expect(exchanges).toBe(0);
    expect(await readClaudeTokens("default")).toEqual(original);
  });

  test("tokens refresh once across competing clients and preserve rotated refresh tokens", async () => {
    await saveClaudeTokens("default", { ...fresh(), expiresAt: Date.now() - 1000 });
    let calls = 0;
    const fetcher = async (_: string, init: RequestInit) => {
      calls++;
      expect(parseJSON(bodyText(init.body))).toEqual({ client_id: CLAUDE_CLIENT_ID, grant_type: "refresh_token", refresh_token: "test-refresh" });
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
      import { claudeCredentials } from ${JSON.stringify(join(import.meta.dir, "claude.ts"))};
      const credentials = claudeCredentials("workers", async () => {
        await Bun.write(process.env.ORCA2_HOME + "/refresh-" + process.pid, "called");
        await Bun.sleep(100);
        return Response.json({ access_token: "worker-access", refresh_token: "worker-refresh", expires_in: 3600 });
      });
      const result = await credentials();
      if (result.token !== "worker-access") process.exit(1);
    `);
    const workers = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, script], {
      env: { ...process.env, ORCA2_HOME: home }, stdout: "pipe", stderr: "pipe",
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
    const source = join(required(process.env.CLAUDE_CONFIG_DIR), ".credentials.json");
    const data = JSON.stringify({ claudeAiOauth: fresh() });
    await Bun.write(source, data);
    await saveClaudeTokens("work", { ...fresh(), accessToken: "work-access" });
    expect(await importClaudeCode("personal")).toEqual({ ok: true, data: null });
    expect((await readClaudeTokens("personal"))?.accessToken).toBe("test-access");
    expect((await readClaudeTokens("work"))?.accessToken).toBe("work-access");
    expect(await Bun.file(source).text()).toBe(data);
    expect(claudeProfiles()).toEqual(["personal", "work"]);
  });

  test("missing, invalid and unsafe profiles fail without reading developer-platform credentials", async () => {
    await expect(claudeCredentials("missing")()).rejects.toThrow("not signed in");
    expect(refused(await importClaudeCode("missing"))).toContain("no claude code login");
    for (const name of ["../outside", "a/b", "", "env", "x".repeat(65)]) {
      await expect(saveClaudeTokens(name, fresh())).rejects.toThrow("profile must");
    }
    await Bun.write(claudeCredentialsPath("invalid"), "not JSON");
    await expect(readClaudeTokens("invalid")).rejects.toThrow("invalid");
  });
});

describe("Codex credentials", () => {
  const refused = (result: { ok: true; data: null } | { ok: false; error: string }): string => result.ok ? "" : result.error;
  function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("missing test value");
    return value;
  }
  const bodyText = (body: RequestInit["body"]): string => typeof body === "string" ? body : "";

  let home: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.ORCA2_HOME;
    home = mkdtempSync(join(tmpdir(), "orca-codex-"));
    process.env.ORCA2_HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.ORCA2_HOME;
    else process.env.ORCA2_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function expectShortLink(output: string, port: string, full: string, file: string) {
    const link = output.match(/http:\/\/localhost:\d+\/login\/[\w-]+/)?.[0];
    expect(link).toBeDefined();
    expect(required(link).length).toBeLessThan(50);
    expect(output).not.toContain(full);
    expect(output).toContain(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(full);
    const short = new URL(required(link));
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
    const signedIn = await loginCodex("personal", {
      port: 0, write(text) { output += text; },
      openBrowser(url) {
        authorization = new URL(url);
        callback = (async () => {
          expect(authorization.origin + authorization.pathname).toBe("https://auth.openai.com/oauth/authorize");
          expect(authorization.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
          expect(authorization.searchParams.get("originator")).toBe("codex_cli_rs");
          expect(authorization.searchParams.get("codex_cli_simplified_flow")).toBe("true");
          expect(authorization.searchParams.get("scope")).toContain("offline_access");
          const target = new URL(required(authorization.searchParams.get("redirect_uri")));
          expect(target.pathname).toBe("/auth/callback");
          target.hostname = "127.0.0.1";
          await expectShortLink(output, target.port, authorization.toString(), join(home, ".runtime", "login-url.txt"));
          target.search = new URLSearchParams({ code: "test-code", state: "wrong" }).toString();
          expect((await fetch(target)).status).toBe(400);
          expect(await readCodexTokens("personal")).toBeNull();
          target.searchParams.set("state", required(authorization.searchParams.get("state")));
          expect((await fetch(target)).status).toBe(200);
        })();
      },
      async fetcher(url, init) {
        expect(url).toBe(CODEX_TOKEN_URL);
        expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
        const body = new URLSearchParams(bodyText(init.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe(CODEX_CLIENT_ID);
        expect(body.get("code")).toBe("test-code");
        expect(body.get("state")).toBe(authorization.searchParams.get("state"));
        expect(body.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
        expect(createHash("sha256").update(required(body.get("code_verifier"))).digest("base64url")).toBe(required(authorization.searchParams.get("code_challenge")));
        expect(init.redirect).toBe("error");
        return Response.json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_in: 3600 });
      },
    });
    expect(signedIn).toEqual({ ok: true, data: null });
    await callback;
    expect((await readCodexTokens("personal"))?.accountId).toBe("test-account");
    expect(statSync(codexCredentialsPath("personal")).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(tokens.accessToken);
    expect(output).not.toContain(tokens.refreshToken);
    expect(existsSync(join(home, ".runtime", "login-url.txt"))).toBe(false);
  });

  test("Codex refresh is serialized and persists rotated tokens and account routing", async () => {
    await saveCodexTokens("default", fakeCodexTokens("test-account", Date.now() - 1000));
    const next = fakeCodexTokens("test-account", Date.now() + 3_600_000, "new");
    let refreshes = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      refreshes++;
      expect(url).toBe(CODEX_TOKEN_URL);
      expect(Object.fromEntries(new URLSearchParams(bodyText(init.body)))).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: "test-refresh" });
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
    expect(await importCodex("personal", file)).toEqual({ ok: true, data: null });
    expect((await readCodexTokens("personal"))?.accessToken).toBe(tokens.accessToken);
    expect(await Bun.file(file).text()).toBe(data);
    await Bun.write(file, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "unused-key" }));
    expect(refused(await importCodex("api", file))).toContain("chatgpt subscription login");
    expect(await readCodexTokens("api")).toBeNull();
  });

  test("Codex cancellation leaves the old profile intact", async () => {
    const tokens = fakeCodexTokens();
    await saveCodexTokens("personal", tokens);
    const abort = new AbortController();
    expect(refused(await loginCodex("personal", {
      port: 0, signal: abort.signal, write() {}, openBrowser() { abort.abort(); },
    }))).toContain("cancelled");
    expect(await readCodexTokens("personal")).toEqual(tokens);
  });
});

describe("accounts and the provider they select", () => {
  async function provider(...args: Parameters<typeof loadProvider>): Promise<Provider> {
    const loaded = await loadProvider(...args);
    if (!loaded.ok) throw new Error(loaded.error);
    return loaded.data;
  }
  async function refusal(...args: Parameters<typeof loadProvider>): Promise<string> {
    const loaded = await loadProvider(...args);
    return loaded.ok ? "" : loaded.error;
  }
  function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("missing test value");
    return value;
  }

  const keys = ["ORCA2_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENAI_CUSTOM_HEADERS", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"];
  let original: Record<string, string | undefined>;
  let home: string;
  let mockFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  beforeEach(() => {
    original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    home = mkdtempSync(join(tmpdir(), "orca-accounts-"));
    process.env.ORCA2_HOME = home;
    process.env.ANTHROPIC_CONFIG_DIR = join(home, "ant");
  });
  afterEach(() => {
    mockFetch?.mockRestore();
    mockFetch = undefined;
    clearCatalogEfforts();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function saveProfile(name: string, token = "subscription-access") {
    await saveClaudeTokens(name, { accessToken: token, refreshToken: "subscription-refresh", expiresAt: Date.now() + 3_600_000 });
  }

  test("named subscription profiles load without any default login and expose only their local identity", async () => {
    await saveCodexTokens("phoebe", fakeCodexTokens("fixture-account"));
    await saveProfile("personal");
    expect((await provider("openai", { profile: "phoebe" })).account).toBe("openai:phoebe");
    expect((await provider("anthropic", { profile: "personal" })).account).toBe("anthropic:personal");
    expect(await refusal("openai")).toContain("default");
    expect(await refusal("anthropic", { profile: "missing" })).toContain("missing");
  });

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

  const turn = (onText: (text: string) => void = () => {}): CompleteRequest => ({
    model: "claude-test", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    maxTokens: 100, onText,
  });

  function interceptFetch(handler: (request: Request) => Promise<Response>) {
    mockFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        return handler(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      },
      { preconnect: fetch.preconnect },
    ));
  }

  test("subscription requests use Bearer auth, Claude Code compatibility, streaming tools and model discovery", async () => {
    await saveProfile("personal");
    process.env.ANTHROPIC_AUTH_TOKEN = "wrong-platform-token";
    process.env.ANTHROPIC_PROFILE = "wrong-profile";
    process.env.ANTHROPIC_BASE_URL = "https://wrong.example";
    const requests: Request[] = [];
    interceptFetch(async (request) => {
      requests.push(request);
      if (request.url.endsWith("/v1/models")) return Response.json({ data: [{ id: "claude-test", type: "model", display_name: "Test", created_at: "2026-01-01T00:00:00Z",
        capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true }, xhigh: null, max: { supported: true } } } }], has_more: false, first_id: "claude-test", last_id: "claude-test" });
      return streamResponse();
    });
    const client = await provider("anthropic", { profile: "personal" });
    let text = "";
    const req = turn((delta) => { text += delta; });
    const result = await client.complete(req);
    expect(text).toBe("hello");
    expect(result.stop).toBe("tool_use");
    expect(result.content[1]).toMatchObject({ type: "tool_use", name: "bash", id: "tool_1", input: { command: "pwd" } });
    expect(await client.models()).toEqual(["claude-test"]);
    expect(modelCapabilities("claude-test").effort).toEqual(["low", "high", "max"]);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe("https://api.anthropic.com");
      expect(request.headers.get("authorization")).toBe("Bearer subscription-access");
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("anthropic-beta")).toBe(CLAUDE_BETAS);
    }
    const body = z.record(z.string(), z.unknown()).parse(await required(requests[0]).json());
    expect(body.system).toEqual([{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
    expect(body.messages).toEqual(req.messages);
    expect(body.tools).toEqual(req.tools);
    expect(body.stream).toBe(true);
    expect(req).not.toHaveProperty("system");
  });

  test("API keys cannot override Claude Code subscription credentials", async () => {
    await saveProfile("personal");
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "unused-token";
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Api-Key: unused-custom-key";
    let request: Request | undefined;
    interceptFetch(async (incoming) => {
      request = incoming;
      return streamResponse();
    });
    const listed = await accounts({ provider: "anthropic", profile: "personal" });
    expect(listed.find((a) => a.id === "anthropic:env")).toBeUndefined();
    expect(listed.find((a) => a.id === "anthropic:personal")?.active).toBe(true);
    await (await provider("anthropic", { profile: "personal" })).complete(turn());
    expect(required(request).headers.get("x-api-key")).toBeNull();
    expect(required(request).headers.get("authorization")).toBe("Bearer subscription-access");
    expect(required(request).headers.get("anthropic-beta")).toBe(CLAUDE_BETAS);
    expect(await required(request).json()).toHaveProperty("system");
  });

  test("environment and legacy saved API keys cannot authenticate either provider", async () => {
    process.env.ANTHROPIC_API_KEY = "unused-anthropic-key";
    process.env.OPENAI_API_KEY = "unused-openai-key";
    await Bun.write(join(home, "credentials.json"), JSON.stringify({ openai: "unused-saved-key" }));
    expect(await refusal("anthropic", { profile: "none" })).toContain("not signed in");
    expect(await refusal("openai", { profile: "none" })).toContain("not signed in");
    expect(await accounts()).toEqual([]);
    expect(await accounts({ provider: "openai", profile: "default" })).toEqual([]);
  });

  test("Codex account selection stays independent of Claude and ignores API credentials", async () => {
    process.env.OPENAI_API_KEY = "unused-openai-key";
    process.env.OPENAI_ADMIN_KEY = "unused-admin-key";
    process.env.OPENAI_CUSTOM_HEADERS = "Authorization: Bearer unused-header-key\nX-Api-Key: unused-custom-key";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_ORG_ID = "unused-org";
    process.env.OPENAI_PROJECT_ID = "unused-project";
    await saveProfile("personal");
    await saveCodexTokens("work", fakeCodexTokens("work-account"));
    await saveCodexTokens("personal", fakeCodexTokens("personal-account"));
    const listed = await accounts({ provider: "openai", profile: "work" });
    expect(listed.filter((a) => a.active).map((a) => a.id)).toEqual(["openai:work"]);
    expect(listed.find((a) => a.id === "openai:work")).toMatchObject({ active: true, source: "codex (chatgpt subscription)" });
    expect(listed.find((a) => a.id === "anthropic:personal")?.active).toBe(false);
    expect(listed.find((a) => a.id === "openai:personal")?.active).toBe(false);
    expect((await accounts()).some((a) => a.active)).toBe(false);
    interceptFetch(async (request) => {
      expect(request.url).toStartWith("https://chatgpt.com/backend-api/codex/models?");
      expect(request.headers.get("chatgpt-account-id")).toBe("work-account");
      expect(request.headers.get("authorization")).not.toContain("unused");
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("openai-organization")).toBeNull();
      expect(request.headers.get("openai-project")).toBeNull();
      return Response.json({ models: [{ slug: "gpt-test", visibility: "list" }] });
    });
    expect(await (await provider("openai", { profile: "work" })).models()).toEqual(["gpt-test"]);
    expect(await refusal("openai", { profile: "missing" })).toContain("not signed in");
  });

  test("custom Anthropic Authorization headers cannot select a different authentication flow", async () => {
    await saveProfile("default");
    process.env.ANTHROPIC_CUSTOM_HEADERS = "Authorization: Bearer platform-token";
    expect(await refusal("anthropic")).toContain("custom anthropic authorization headers are unsupported");
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
    await (await provider("anthropic", { profile: "default" })).complete(turn());
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
    const first = await provider("anthropic", { profile: "one" });
    await first.complete(turn());
    await (await provider("anthropic", { profile: "two" })).complete(turn());
    expect(used).toEqual(["Bearer account-one", "Bearer account-two"]);
    expect((await accounts({ provider: "anthropic", profile: "two" })).find((a) => a.id === "anthropic:two")?.active).toBe(true);
    await Bun.write(join(required(process.env.ANTHROPIC_CONFIG_DIR), "credentials", "legacy.json"), JSON.stringify({ access_token: "platform-token" }));
    expect(await refusal("anthropic", { profile: "legacy" })).toContain("not signed in");
    expect((await accounts({ provider: "anthropic", profile: "legacy" })).find((a) => a.id === "anthropic:legacy")).toBeUndefined();
    expect(used).toHaveLength(2);
  });
});
