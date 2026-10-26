// Codex's ChatGPT subscription OAuth; platform API keys are never credentials here.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/config";
import { loginOAuth, validateProfile, type OAuthTokens, withCredentialLock, writeTokens, type Fetch, type LoginOptions } from "./oauth";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export interface CodexTokens extends OAuthTokens { accountId: string }

const authDir = () => join(paths.root, "auth", "openai");
export const codexCredentialsPath = (profile: string) => join(authDir(), `${validateProfile(profile)}.json`);
export function codexProfiles(): string[] {
  if (!existsSync(authDir())) return [];
  return readdirSync(authDir()).filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(f))
    .map((f) => f.slice(0, -5)).filter((p) => p !== "env").sort();
}

function claims(token: string): { exp?: number; accountId: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId || /[\r\n]/.test(accountId)) throw new Error();
    // Claims provide routing metadata only; the remote server validates the token.
    return { exp: payload.exp, accountId };
  } catch {
    throw new Error("codex access token has no chatgpt account; run /login openai again.");
  }
}

function tokensFrom(value: unknown): CodexTokens {
  const data = value as Partial<CodexTokens> | null;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken ||
      typeof data.refreshToken !== "string" || !data.refreshToken ||
      typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt <= 0) {
    throw new Error("codex credentials are invalid; run /login openai again.");
  }
  const { accountId } = claims(data.accessToken);
  if (data.accountId !== undefined && data.accountId !== accountId) throw new Error("codex account does not match its token; run /login openai again.");
  return { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt, accountId };
}

export async function readCodexTokens(profile: string): Promise<CodexTokens | null> {
  const file = Bun.file(codexCredentialsPath(profile));
  if (!(await file.exists())) return null;
  try { return tokensFrom(await file.json()); }
  catch { throw new Error(`codex profile '${profile}' is invalid; run /login openai ${profile} again.`); }
}

export async function saveCodexTokens(profile: string, tokens: CodexTokens, signal?: AbortSignal): Promise<void> {
  const path = codexCredentialsPath(profile);
  const checked = tokensFrom(tokens);
  await withCredentialLock(path, () => {
    signal?.throwIfAborted();
    return writeTokens(path, checked, signal);
  });
}

async function requestTokens(body: Record<string, string>, fetcher: Fetch, previous?: CodexTokens, signal?: AbortSignal): Promise<CodexTokens> {
  let response: Response;
  try {
    response = await fetcher(CODEX_TOKEN_URL, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, ...body }).toString(),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
  } catch { throw new Error("codex oauth request failed or timed out; try again."); }
  if (!response.ok) throw new Error(`codex oauth failed (http ${response.status}); run /login openai again.`);
  try {
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
        (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer")) throw new Error();
    return tokensFrom({
      accessToken: data.access_token, refreshToken: data.refresh_token ?? previous?.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000, accountId: previous?.accountId,
    });
  } catch { throw new Error("codex oauth returned invalid credentials; try logging in again."); }
}

export function codexCredentials(profile: string, fetcher: Fetch = fetch) {
  const path = codexCredentialsPath(profile);
  let previousToken: string | undefined;
  return async (opts?: { forceRefresh?: boolean }) => withCredentialLock(path, async () => {
    let tokens = await readCodexTokens(profile);
    if (!tokens) throw new Error(`codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
    if ((opts?.forceRefresh && tokens.accessToken === previousToken) || tokens.expiresAt <= Date.now() + 120_000) {
      tokens = await requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, fetcher, tokens);
      await writeTokens(path, tokens);
    }
    previousToken = tokens.accessToken;
    return tokens;
  });
}

/** Import a ChatGPT login only. An API-key-only native auth file is rejected. */
export async function importCodex(profile: string, authPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")): Promise<void> {
  validateProfile(profile);
  const file = Bun.file(authPath);
  if (!(await file.exists())) throw new Error("no codex file login found; use /login openai to sign in with chatgpt.");
  let tokens: CodexTokens;
  try {
    const data = await file.json();
    if (data.auth_mode && data.auth_mode !== "chatgpt") throw new Error();
    const source = data.tokens;
    const metadata = claims(source.access_token);
    tokens = tokensFrom({ accessToken: source.access_token, refreshToken: source.refresh_token,
      expiresAt: typeof metadata.exp === "number" ? metadata.exp * 1000 : 1,
      accountId: source.account_id ?? metadata.accountId });
  } catch { throw new Error("no valid codex chatgpt subscription login found; use /login openai."); }
  await saveCodexTokens(profile, tokens);
}

export async function loginCodex(profile: string, options: LoginOptions): Promise<void> {
  validateProfile(profile);
  await loginOAuth({
    label: "chatgpt (codex)", authorizeURL: "https://auth.openai.com/oauth/authorize", clientId: CODEX_CLIENT_ID,
    scope: "openid profile email offline_access", port: 1455, callbackPath: "/auth/callback",
    extraParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
    async exchange(body, fetcher, signal) {
      await saveCodexTokens(profile, await requestTokens(body, fetcher, undefined, signal), signal);
    },
  }, options);
}
