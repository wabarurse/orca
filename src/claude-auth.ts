// Claude subscription OAuth, separate from the developer-platform `ant` profiles.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { loginOAuth, validateProfile, withCredentialLock, writeTokens, type Fetch, type LoginOptions, type OAuthTokens as ClaudeTokens } from "./oauth";
export { validateProfile } from "./oauth";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_BETAS = "claude-code-20250219,oauth-2025-04-20";
const SCOPES = "user:profile user:inference user:sessions:claude_code";
const REFRESH_MARGIN_MS = 120_000;

export type { OAuthTokens as ClaudeTokens } from "./oauth";
const authDir = () => join(paths.root, "auth", "anthropic");

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

/** Claude Code is the only Claude login mode. */
export async function loginClaude(profile: string, options: LoginOptions): Promise<void> {
  validateProfile(profile);
  await loginOAuth({
    label: "Claude", authorizeURL: "https://claude.ai/oauth/authorize", clientId: CLAUDE_CLIENT_ID,
    scope: SCOPES, port: 53692, callbackPath: "/callback", extraParams: { code: "true" },
    async exchange(body, fetcher, signal) {
      await saveClaudeTokens(profile, await requestTokens(body, fetcher, undefined, signal), signal);
    },
  }, options);
}
