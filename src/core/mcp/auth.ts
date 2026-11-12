// OAuth sign-in for an HTTP MCP server. Tokens live in .runtime/mcp-auth/, private to the user,
// keyed by the server's name and address; mcp.json never holds them.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { paths } from "../../config";
import { withStorageLock } from "../data";
import { loginKey, type Server } from "./config";

interface Credentials { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirect?: string }
type Target = Pick<Server, "name" | "url">;
const file = (s: Target) => join(paths.runtime, "mcp-auth", `${loginKey(s)}.json`);
async function load(s: Target): Promise<Credentials> {
  return JSON.parse(await readFile(file(s), "utf8").catch(e => { if (e.code === "ENOENT") return "{}"; throw e; }));
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
export async function signedIn(s: Target): Promise<boolean> { return !!(await load(s)).tokens; }
export async function logoutServer(s: Target): Promise<void> { await unlink(file(s)).catch(e => { if (e.code !== "ENOENT") throw e; }); }

/** Without `interactive` this only uses and refreshes a saved sign-in; a server that needs a new one says how to get it. */
export function oauthProvider(s: Target, interactive?: { redirect: string; state: string; show(url: string): void }): OAuthClientProvider {
  let verifier: string | undefined;
  const redirect = async () => interactive?.redirect ?? (await load(s)).redirect ?? "http://127.0.0.1/callback";
  // The SDK reads these two synchronously; a saved redirect is only needed to match saved client information, below.
  const fixed = interactive?.redirect ?? "http://127.0.0.1/callback";
  return {
    redirectUrl: fixed,
    clientMetadata: { client_name: "Orca", redirect_uris: [fixed], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => interactive?.state ?? crypto.randomUUID(),
    clientInformation: async () => { const saved = await load(s); return !interactive || saved.redirect === await redirect() ? saved.client : undefined; },
    saveClientInformation: async client => save(s, { client, redirect: await redirect() }),
    tokens: async () => (await load(s)).tokens,
    saveTokens: async tokens => save(s, { tokens, redirect: await redirect() }),
    redirectToAuthorization: url => {
      if (!interactive) throw new Error(`MCP server ${s.name} needs a sign-in; run: orca mcp login ${s.name}`);
      interactive.show(url.href);
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error("the sign-in expired; start it again"); return verifier; },
    invalidateCredentials: scope => save(s, scope === "client" ? { client: undefined } : scope === "tokens" ? { tokens: undefined } : { client: undefined, tokens: undefined }),
  };
}

/** The browser sign-in: `show` gets the address to open; the answer comes back to a one-time local page. Three minutes. */
export async function loginServer(s: Server, show: (url: string) => void, signal?: AbortSignal): Promise<void> {
  if (!s.url) throw new Error(`${s.name} is a local command; only a url server has a sign-in`);
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const state = crypto.randomUUID();
  let resolve!: (code: string) => void, reject!: (error: unknown) => void;
  const code = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void code.catch(() => {});
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) return new Response("Invalid callback", { status: 400 });
    if (u.searchParams.has("error")) { reject(new Error("the sign-in was declined")); return new Response("Sign-in cancelled"); }
    const value = u.searchParams.get("code");
    if (!value) return new Response("Missing code", { status: 400 });
    resolve(value); return new Response("Connected. You can return to Orca.", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }});
  const cancelled = () => reject(abort.reason);
  abort.addEventListener("abort", cancelled, { once: true });
  try {
    abort.throwIfAborted();
    const provider = oauthProvider(s, { redirect: `http://127.0.0.1:${server.port}/callback`, state, show });
    const fetchFn = (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([abort, init.signal]) : abort });
    if (await auth(provider, { serverUrl: s.url, fetchFn }) === "REDIRECT") await auth(provider, { serverUrl: s.url, authorizationCode: await code, fetchFn });
  } finally { abort.removeEventListener("abort", cancelled); server.stop(true); }
}
