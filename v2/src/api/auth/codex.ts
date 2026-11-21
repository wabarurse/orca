import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fail, ok, paths, type Result } from "../../config";
import { CredentialError, loginOAuth, parseProfile, validateProfile, type OAuthTokens, withCredentialLock, writeTokens, type Fetch, type LoginOptions } from "./oauth";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export type CodexTokens = OAuthTokens & { accountId: string };

const authDir = () => join(paths.runtime, "auth", "openai");
export const codexCredentialsPath = (profile: string) => join(authDir(), `${validateProfile(profile)}.json`);
export function codexProfiles(): string[] {
  if (!existsSync(authDir())) return [];
  return readdirSync(authDir()).filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(f))
    .map((f) => f.slice(0, -5)).filter((p) => p !== "env").sort();
}

const tokenClaims = z.object({
  exp: z.unknown().optional(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().min(1).regex(/^[^\r\n]*$/) }),
});

const storedTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().positive(),
  accountId: z.unknown().optional(),
});

const tokenResponse = z.object({
  access_token: z.unknown().optional(),
  refresh_token: z.unknown().optional(),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

const nativeAuth = z.object({
  auth_mode: z.unknown().optional(),
  tokens: z.object({ access_token: z.string(), refresh_token: z.unknown().optional(), account_id: z.unknown().optional() }),
});

function claims(token: string): Result<{ exp: unknown; accountId: string }> {
  const invalid = fail("codex access token has no chatgpt account; run /login openai again.");
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return invalid;
  let json: unknown;
  try { json = JSON.parse(Buffer.from(payload, "base64url").toString()); }
  catch { return invalid; }
  const parsed = tokenClaims.safeParse(json);
  if (!parsed.success) return invalid;
  return ok({ exp: parsed.data.exp, accountId: parsed.data["https://api.openai.com/auth"].chatgpt_account_id });
}

function parseTokens(value: unknown): Result<CodexTokens> {
  const data = storedTokens.safeParse(value);
  if (!data.success) return fail("codex credentials are invalid; run /login openai again.");
  const claimed = claims(data.data.accessToken);
  if (!claimed.ok) return claimed;
  const { accountId } = claimed.data;
  if (data.data.accountId !== undefined && data.data.accountId !== accountId) return fail("codex account does not match its token; run /login openai again.");
  return ok({ accessToken: data.data.accessToken, refreshToken: data.data.refreshToken, expiresAt: data.data.expiresAt, accountId });
}

function tokensFrom(value: unknown): CodexTokens {
  const parsed = parseTokens(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

export async function readCodexTokens(profile: string): Promise<CodexTokens | null> {
  const file = Bun.file(codexCredentialsPath(profile));
  if (!(await file.exists())) return null;
  const content: unknown = await file.json().catch(() => undefined);
  const parsed = parseTokens(content);
  if (!parsed.ok) throw new CredentialError("credentials-invalid", `codex profile '${profile}' is invalid; run /login openai ${profile} again.`);
  return parsed.data;
}

export async function saveCodexTokens(profile: string, tokens: CodexTokens, signal?: AbortSignal): Promise<void> {
  const path = codexCredentialsPath(profile);
  const checked = tokensFrom(tokens);
  await withCredentialLock(path, () => {
    signal?.throwIfAborted();
    return writeTokens(path, checked, signal);
  });
}

async function requestTokens(body: Record<string, string>, fetcher: Fetch, previous?: CodexTokens, signal?: AbortSignal): Promise<Result<CodexTokens, CredentialError>> {
  let response: Response;
  try {
    response = await fetcher(CODEX_TOKEN_URL, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, ...body }).toString(),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal !== undefined ? [signal] : [])]),
    });
  } catch { return fail(new CredentialError("oauth-connection", "codex oauth request failed or timed out; try again.")); }
  if (!response.ok) return fail(new CredentialError("oauth-http", `codex oauth failed (http ${response.status}); run /login openai again.`, response.status));
  const invalid = new CredentialError("oauth-response", "codex oauth returned invalid credentials; try logging in again.");
  const json: unknown = await response.json().catch(() => undefined);
  const data = tokenResponse.safeParse(json);
  if (!data.success || (data.data.token_type !== undefined && data.data.token_type.toLowerCase() !== "bearer")) return fail(invalid);
  const tokens = parseTokens({
    accessToken: data.data.access_token, refreshToken: data.data.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + data.data.expires_in * 1000, accountId: previous?.accountId,
  });
  return tokens.ok ? tokens : fail(invalid);
}

export function codexCredentials(profile: string, fetcher: Fetch = fetch) {
  const path = codexCredentialsPath(profile);
  let previousToken: string | undefined;
  return async (opts?: { forceRefresh?: boolean }) => withCredentialLock(path, async () => {
    let tokens = await readCodexTokens(profile);
    if (tokens === null) throw new CredentialError("credentials-invalid", `codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
    if ((opts?.forceRefresh === true && tokens.accessToken === previousToken) || tokens.expiresAt <= Date.now() + 120_000) {
      const refreshed = await requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, fetcher, tokens);
      if (!refreshed.ok) throw refreshed.error;
      tokens = refreshed.data;
      await writeTokens(path, tokens);
    }
    previousToken = tokens.accessToken;
    return tokens;
  });
}

async function nativeTokens(authPath: string): Promise<Result<CodexTokens>> {
  const invalid = fail("no valid codex chatgpt subscription login found; use /login openai.");
  const json: unknown = await Bun.file(authPath).json().catch(() => undefined);
  const data = nativeAuth.safeParse(json);
  if (!data.success) return invalid;
  const mode = data.data.auth_mode;
  if (mode !== undefined && mode !== null && mode !== false && mode !== 0 && mode !== "" && mode !== "chatgpt") return invalid;
  const source = data.data.tokens;
  const metadata = claims(source.access_token);
  if (!metadata.ok) return invalid;
  const tokens = parseTokens({ accessToken: source.access_token, refreshToken: source.refresh_token,
    expiresAt: typeof metadata.data.exp === "number" ? metadata.data.exp * 1000 : 1,
    accountId: source.account_id ?? metadata.data.accountId });
  return tokens.ok ? tokens : invalid;
}

export async function importCodex(profile: string, authPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")): Promise<Result<null>> {
  const named = parseProfile(profile);
  if (!named.ok) return named;
  if (!(await Bun.file(authPath).exists())) return fail("no codex file login found; use /login openai to sign in with chatgpt.");
  const tokens = await nativeTokens(authPath);
  if (!tokens.ok) return tokens;
  await saveCodexTokens(profile, tokens.data);
  return ok(null);
}

export async function loginCodex(profile: string, options: LoginOptions): Promise<Result<null>> {
  const named = parseProfile(profile);
  if (!named.ok) return named;
  return loginOAuth({
    label: "chatgpt (codex)", authorizeURL: "https://auth.openai.com/oauth/authorize", clientId: CODEX_CLIENT_ID,
    scope: "openid profile email offline_access", port: 1455, callbackPath: "/auth/callback",
    extraParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
    async exchange(body, fetcher, signal) {
      const tokens = await requestTokens(body, fetcher, undefined, signal);
      if (!tokens.ok) return fail(tokens.error.message);
      await saveCodexTokens(profile, tokens.data, signal);
      return ok(null);
    },
  }, options);
}
