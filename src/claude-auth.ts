// Claude subscription OAuth, separate from the developer-platform `ant` profiles.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "./config";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_BETAS = "claude-code-20250219,oauth-2025-04-20";
const SCOPES = "user:profile user:inference user:sessions:claude_code";
const REFRESH_MARGIN_MS = 120_000;

export interface ClaudeTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds, matching Claude Code's credential format. */
  expiresAt: number;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const authDir = () => join(paths.root, "auth", "anthropic");

export function validateProfile(profile: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile) || profile === "env") {
    throw new Error("Profile must be 1–64 letters, numbers, dots, underscores or hyphens, start with a letter or number, and not be 'env'.");
  }
  return profile;
}

export const claudeCredentialsPath = (profile: string) => join(authDir(), `${validateProfile(profile)}.json`);

export function claudeProfiles(): string[] {
  if (!existsSync(authDir())) return [];
  return readdirSync(authDir()).filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(f))
    .map((f) => f.slice(0, -5)).filter((p) => p !== "env").sort();
}

function tokensFrom(value: unknown): ClaudeTokens {
  const v = value as Partial<ClaudeTokens> | null;
  if (!v || typeof v.accessToken !== "string" || !v.accessToken ||
      typeof v.refreshToken !== "string" || !v.refreshToken ||
      typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt) || v.expiresAt <= 0) {
    throw new Error("Claude OAuth credentials are invalid; run /login anthropic again.");
  }
  return { accessToken: v.accessToken, refreshToken: v.refreshToken, expiresAt: v.expiresAt };
}

export async function readClaudeTokens(profile: string): Promise<ClaudeTokens | null> {
  const file = Bun.file(claudeCredentialsPath(profile));
  if (!(await file.exists())) return null;
  try {
    return tokensFrom(await file.json());
  } catch {
    throw new Error(`Claude profile '${profile}' is invalid; run /login anthropic ${profile} again.`);
  }
}

async function writeTokens(path: string, tokens: ClaudeTokens, signal?: AbortSignal): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    // Private from creation, including during replacement of an existing file.
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(tokens) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Serialize login/refresh across the orchestrator and its tmux processes. */
async function withCredentialLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Never steal a lock on a timer: a paused worker can still own it.
      if (Date.now() >= deadline) throw new Error(`Claude credential lock timed out: ${lock}. If a process was killed, stop the agents and remove this lock directory before retrying.`);
      await Bun.sleep(50);
    }
  }
  try {
    await Bun.write(join(lock, "pid"), String(process.pid));
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function saveClaudeTokens(profile: string, tokens: ClaudeTokens, signal?: AbortSignal): Promise<void> {
  const path = claudeCredentialsPath(profile);
  const checked = tokensFrom(tokens);
  await withCredentialLock(path, () => {
    signal?.throwIfAborted();
    return writeTokens(path, checked, signal);
  });
}

async function requestTokens(body: Record<string, string>, fetcher: Fetch, fallbackRefresh?: string, signal?: AbortSignal): Promise<ClaudeTokens> {
  let response: Response;
  try {
    response = await fetcher(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: CLAUDE_CLIENT_ID, ...body }),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      redirect: "error",
    });
  } catch {
    throw new Error("Claude OAuth request failed or timed out; try again.");
  }
  // Never include the response body: providers can echo credentials on errors.
  if (!response.ok) throw new Error(`Claude OAuth failed (HTTP ${response.status}); run /login anthropic again.`);
  try {
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
        (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer")) throw new Error();
    return tokensFrom({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? fallbackRefresh,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
  } catch {
    throw new Error("Claude OAuth returned invalid credentials; try logging in again.");
  }
}

/** SDK credential callback: refresh near expiry and once after a rejected token. */
export function claudeCredentials(profile: string, fetcher: Fetch = fetch) {
  const path = claudeCredentialsPath(profile);
  let previousToken: string | undefined;
  return async (opts?: { forceRefresh?: boolean }) => withCredentialLock(path, async () => {
    let tokens = await readClaudeTokens(profile);
    if (!tokens) throw new Error(`Claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    // Another process may already have replaced the token rejected by this client.
    const rejected = opts?.forceRefresh && tokens.accessToken === previousToken;
    if (rejected || tokens.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      tokens = await requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, fetcher, tokens.refreshToken);
      await writeTokens(path, tokens);
    }
    previousToken = tokens.accessToken;
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt / 1000 };
  });
}

/** Explicit bootstrap only; neither account listing nor tests read the keychain. */
export async function importClaudeCode(profile: string): Promise<void> {
  validateProfile(profile);
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let value: unknown;
  for (const name of [".credentials.json", "credentials.json"]) {
    const file = Bun.file(join(dir, name));
    if (await file.exists()) {
      try { value = await file.json(); } catch { throw new Error("Claude Code credentials could not be read; use /login anthropic."); }
      break;
    }
  }
  if (value === undefined && process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    const result = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    if (result.exitCode === 0) {
      try { value = JSON.parse(result.stdout.toString()); } catch { /* Report the same actionable error below. */ }
    }
  }
  if (!value) throw new Error("No Claude Code login found; use /login anthropic to sign in with your Claude subscription.");
  const data = value as Record<string, unknown>;
  await saveClaudeTokens(profile, tokensFrom(data.claudeAiOauth ?? data.oauth ?? data));
}

interface LoginOptions {
  write: (text: string) => void;
  openBrowser?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
  port?: number;
  fetcher?: Fetch;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref(); } catch { /* Printed URL remains usable. */ }
}

/** Loopback PKCE flow using the same redirect as zeta's Claude login. */
export async function loginClaude(profile: string, options: LoginOptions): Promise<void> {
  validateProfile(profile);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const result = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let received = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 53692,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("Invalid OAuth state", { status: 400 });
      if (received) return new Response("Login already received", { status: 409 });
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        result.reject(new Error("Claude login was cancelled or denied; try /login anthropic again."));
        return new Response("Login was not completed.", { status: 400 });
      }
      received = true;
      try {
        const tokens = await requestTokens({ grant_type: "authorization_code", code, state, code_verifier: verifier, redirect_uri: redirectUri }, options.fetcher ?? fetch, undefined, cancellation.signal);
        await saveClaudeTokens(profile, tokens, cancellation.signal);
        result.resolve();
        return new Response("Signed in to parallels. You can close this tab.");
      } catch (err) {
        result.reject(err);
        return new Response("Login failed. Return to parallels and try again.", { status: 400 });
      }
    },
  });
  const redirectUri = `http://localhost:${server.port}/callback`;
  const url = new URL("https://claude.ai/oauth/authorize");
  url.search = new URLSearchParams({
    code: "true", client_id: CLAUDE_CLIENT_ID, response_type: "code", scope: SCOPES,
    code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: redirectUri,
  }).toString();
  const fail = (message: string) => {
    const error = new Error(message);
    cancellation.abort(error);
    result.reject(error);
  };
  const cancel = () => fail("Claude login cancelled.");
  const timer = setTimeout(() => fail("Claude login timed out; try /login anthropic again."), 5 * 60_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    else {
      options.write(`Sign in with your Claude subscription in your browser:\n${url}\nWaiting for login…`);
      // Do not await browser completion before observing the login promise.
      Promise.resolve().then(() => (options.openBrowser ?? openBrowser)(url.toString())).catch(() => {});
    }
    await result.promise;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await server.stop();
  }
}
