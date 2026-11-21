import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../../config";
import { fail, ok, type Result } from "../result";
import { CredentialError, loginOAuth, validateProfile, withCredentialLock, writeTokens, type Fetch, type LoginOptions, type OAuthTokens as ClaudeTokens } from "./oauth";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SCOPES = "user:profile user:inference user:sessions:claude_code";
const REFRESH_MARGIN_MS = 120_000;

export type { OAuthTokens as ClaudeTokens } from "./oauth";
const authDir = () => join(paths.runtime, "auth", "anthropic");

export const claudeCredentialsPath = (profile: string) => join(authDir(), `${validateProfile(profile)}.json`);

export function claudeProfiles(): string[] {
  if (!existsSync(authDir())) return [];
  return readdirSync(authDir()).filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(f))
    .map((f) => f.slice(0, -5)).filter((p) => p !== "env").sort();
}

const storedTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().positive(),
});

const tokenResponse = z.object({
  access_token: z.unknown().optional(),
  refresh_token: z.unknown().optional(),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

const credentialFile = z.object({ claudeAiOauth: z.unknown().optional(), oauth: z.unknown().optional() }).partial();

function parseTokens(value: unknown): Result<ClaudeTokens> {
  const parsed = storedTokens.safeParse(value);
  if (!parsed.success) return fail("claude oauth credentials are invalid; run /login anthropic again.");
  return ok(parsed.data);
}

function tokensFrom(value: unknown): ClaudeTokens {
  const parsed = parseTokens(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

export async function readClaudeTokens(profile: string): Promise<ClaudeTokens | null> {
  const file = Bun.file(claudeCredentialsPath(profile));
  if (!(await file.exists())) return null;
  const invalid = new CredentialError("credentials-invalid", `claude profile '${profile}' is invalid; run /login anthropic ${profile} again.`);
  const content: unknown = await file.json().catch(() => undefined);
  const parsed = parseTokens(content);
  if (!parsed.ok) throw invalid;
  return parsed.data;
}

export async function saveClaudeTokens(profile: string, tokens: ClaudeTokens, signal?: AbortSignal): Promise<void> {
  const path = claudeCredentialsPath(profile);
  const checked = tokensFrom(tokens);
  await withCredentialLock(path, () => {
    signal?.throwIfAborted();
    return writeTokens(path, checked, signal);
  });
}

async function requestTokens(body: Record<string, string>, fetcher: Fetch, fallbackRefresh?: string, signal?: AbortSignal): Promise<Result<ClaudeTokens, CredentialError>> {
  let response: Response;
  try {
    response = await fetcher(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: CLAUDE_CLIENT_ID, ...body }),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal !== undefined ? [signal] : [])]),
      redirect: "error",
    });
  } catch {
    return fail(new CredentialError("oauth-connection", "claude oauth request failed or timed out; try again."));
  }
  if (!response.ok) return fail(new CredentialError("oauth-http", `claude oauth failed (http ${response.status}); run /login anthropic again.`, response.status));
  const invalid = new CredentialError("oauth-response", "claude oauth returned invalid credentials; try logging in again.");
  const json: unknown = await response.json().catch(() => undefined);
  const data = tokenResponse.safeParse(json);
  if (!data.success || (data.data.token_type !== undefined && data.data.token_type.toLowerCase() !== "bearer")) return fail(invalid);
  const tokens = parseTokens({
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + data.data.expires_in * 1000,
  });
  return tokens.ok ? tokens : fail(invalid);
}

export function claudeCredentials(profile: string, fetcher: Fetch = fetch) {
  const path = claudeCredentialsPath(profile);
  let previousToken: string | undefined;
  return async (opts?: { forceRefresh?: boolean }) => withCredentialLock(path, async () => {
    let tokens = await readClaudeTokens(profile);
    if (tokens === null) throw new CredentialError("credentials-invalid", `claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    const rejected = opts?.forceRefresh === true && tokens.accessToken === previousToken;
    if (rejected || tokens.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      const refreshed = await requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, fetcher, tokens.refreshToken);
      if (!refreshed.ok) throw refreshed.error;
      tokens = refreshed.data;
      await writeTokens(path, tokens);
    }
    previousToken = tokens.accessToken;
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt / 1000 };
  });
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === 0 || value === "";
}

function keychainCredentials(): unknown {
  const result = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  if (result.exitCode !== 0) return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout.toString());
    return value;
  } catch {
    return undefined;
  }
}

export async function importClaudeCode(profile: string): Promise<void> {
  validateProfile(profile);
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const dir = configured ?? join(homedir(), ".claude");
  let value: unknown;
  for (const name of [".credentials.json", "credentials.json"]) {
    const file = Bun.file(join(dir, name));
    if (await file.exists()) {
      const read: Result<unknown> = await file.json().then((data: unknown) => ok(data), () => fail("unreadable"));
      if (!read.ok) throw new Error("claude code credentials could not be read; use /login anthropic.");
      value = read.data;
      break;
    }
  }
  if (value === undefined && process.platform === "darwin" && (configured === undefined || configured === "")) value = keychainCredentials();
  if (absent(value)) throw new Error("no claude code login found; use /login anthropic to sign in with your claude subscription.");
  const wrapped = credentialFile.safeParse(value);
  const inner = wrapped.success ? wrapped.data.claudeAiOauth ?? wrapped.data.oauth ?? value : value;
  await saveClaudeTokens(profile, tokensFrom(inner));
}

export async function loginClaude(profile: string, options: LoginOptions): Promise<void> {
  validateProfile(profile);
  await loginOAuth({
    label: "claude", authorizeURL: "https://claude.ai/oauth/authorize", clientId: CLAUDE_CLIENT_ID,
    scope: SCOPES, port: 53692, callbackPath: "/callback", extraParams: { code: "true" },
    async exchange(body, fetcher, signal) {
      const tokens = await requestTokens(body, fetcher, undefined, signal);
      if (!tokens.ok) throw tokens.error;
      await saveClaudeTokens(profile, tokens.data, signal);
    },
  }, options);
}
