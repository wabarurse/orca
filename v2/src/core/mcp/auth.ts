import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformationFullSchema, OAuthClientInformationSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { errorCode, errorMessage, fail, ok, parseJson, paths, type Result } from "../../config";
import { withStorageLock } from "../lock";
import { loginKey, type Server } from "./config";

const CredentialsFile = z.object({
  client: z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema]).optional(),
  tokens: OAuthTokensSchema.optional(),
  redirect: z.string().optional(),
});
type Credentials = z.infer<typeof CredentialsFile>;
type Target = Pick<Server, "name" | "url">;
const file = (s: Target) => join(paths.runtime, "mcp-auth", `${loginKey(s)}.json`);
async function load(s: Target): Promise<Credentials> {
  const text = await readFile(file(s), "utf8").catch((error: unknown) => { if (errorCode(error) === "ENOENT") return "{}"; throw error; });
  const raw = parseJson(text);
  if (!raw.ok) return {};
  const parsed = CredentialsFile.safeParse(raw.data);
  return parsed.success ? parsed.data : {};
}
async function save(s: Target, patch: Partial<Credentials>): Promise<void> {
  const target = file(s), dir = join(target, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withStorageLock(`${target}.lock`, async () => {
    const tmp = `${target}.${crypto.randomUUID()}`;
    try { await writeFile(tmp, JSON.stringify({ ...await load(s), ...patch }), { mode: 0o600 }); await rename(tmp, target); }
    finally { await unlink(tmp).catch(() => {}); }
  });
}
export async function signedIn(s: Target): Promise<boolean> { return (await load(s)).tokens !== undefined; }
export async function logoutServer(s: Target): Promise<void> { await unlink(file(s)).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; }); }

export function oauthProvider(s: Target, interactive?: { redirect: string; state: string; show(url: string): void }): OAuthClientProvider {
  let verifier: string | null = null;
  const redirect = async () => interactive?.redirect ?? (await load(s)).redirect ?? "http://127.0.0.1/callback";
  const fixed = interactive?.redirect ?? "http://127.0.0.1/callback";
  return {
    redirectUrl: fixed,
    clientMetadata: { client_name: "Orca", redirect_uris: [fixed], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => interactive?.state ?? crypto.randomUUID(),
    clientInformation: async () => { const saved = await load(s); return interactive === undefined || saved.redirect === await redirect() ? saved.client : undefined; },
    saveClientInformation: async client => save(s, { client, redirect: await redirect() }),
    tokens: async () => (await load(s)).tokens,
    saveTokens: async tokens => save(s, { tokens, redirect: await redirect() }),
    redirectToAuthorization: url => {
      if (interactive === undefined) throw new Error(`MCP server ${s.name} needs a sign-in; run: orca2 mcp login ${s.name}`);
      interactive.show(url.href);
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (verifier === null) throw new Error("the sign-in expired; start it again"); return verifier; },
    invalidateCredentials: scope => save(s, scope === "client" ? { client: undefined } : scope === "tokens" ? { tokens: undefined } : { client: undefined, tokens: undefined }),
  };
}

export async function loginServer(s: Server, show: (url: string) => void, signal?: AbortSignal): Promise<Result<null>> {
  const serverUrl = s.url;
  if (serverUrl === undefined || serverUrl === "") return fail(`${s.name} is a local command; only a url server has a sign-in`);
  const abort = signal !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const state = crypto.randomUUID();
  const { promise: code, resolve, reject } = Promise.withResolvers<string>();
  void code.catch(() => {});
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) return new Response("Invalid callback", { status: 400 });
    if (u.searchParams.has("error")) { reject(new Error("the sign-in was declined")); return new Response("Sign-in cancelled"); }
    const value = u.searchParams.get("code");
    if (value === null || value === "") return new Response("Missing code", { status: 400 });
    resolve(value); return new Response("Connected. You can return to Orca.", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }});
  const cancelled = () => { reject(abort.reason); };
  abort.addEventListener("abort", cancelled, { once: true });
  try {
    abort.throwIfAborted();
    const provider = oauthProvider(s, { redirect: `http://127.0.0.1:${server.port}/callback`, state, show });
    const fetchFn = (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal !== undefined && init.signal !== null ? AbortSignal.any([abort, init.signal]) : abort });
    if (await auth(provider, { serverUrl, fetchFn }) === "REDIRECT") await auth(provider, { serverUrl, authorizationCode: await code, fetchFn });
    return ok(null);
  } catch (error) {
    return fail(`${s.name} sign-in failed: ${errorMessage(error)}`);
  } finally { abort.removeEventListener("abort", cancelled); void server.stop(true).catch(() => {}); }
}
