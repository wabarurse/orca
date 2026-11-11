import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { paths } from "../../config";
import { withStorageLock } from "../data/storage-lock";
import { connectionKey, type ConfiguredConnection } from "./config";

interface Credentials { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; redirect?: string }
const file = (c: ConfiguredConnection) => join(paths.runtime, "connection-auth", `${connectionKey(c)}.json`);
async function load(c: ConfiguredConnection): Promise<Credentials> {
  return JSON.parse(await readFile(file(c), "utf8").catch(e => { if (e.code === "ENOENT") return "{}"; throw e; }));
}
async function save(c: ConfiguredConnection, patch: Partial<Credentials>): Promise<void> {
  const target = file(c), dir = join(target, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withStorageLock(`${target}.lock`, async () => {
    const tmp = `${target}.${crypto.randomUUID()}`;
    try { await writeFile(tmp, JSON.stringify({ ...await load(c), ...patch }), { mode: 0o600 }); await rename(tmp, target); }
    finally { await unlink(tmp).catch(() => {}); }
  });
}
export async function logoutConnection(c: ConfiguredConnection): Promise<void> { await unlink(file(c)).catch(e => { if (e.code !== "ENOENT") throw e; }); }
export async function oauthProvider(c: ConfiguredConnection, interactive?: { redirect: string; state: string; show(url: string): void }): Promise<OAuthClientProvider> {
  let verifier: string | undefined;
  const stored = await load(c), redirect = interactive?.redirect ?? stored.redirect ?? "http://127.0.0.1/callback";
  return {
    redirectUrl: redirect,
    clientMetadata: { client_name: "Orca", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => interactive?.state ?? crypto.randomUUID(),
    clientInformation: async () => { const saved = await load(c); return saved.redirect === redirect ? saved.client : undefined; },
    saveClientInformation: client => save(c, { client, redirect }),
    tokens: async () => (await load(c)).tokens,
    saveTokens: tokens => save(c, { tokens, redirect }),
    redirectToAuthorization: url => {
      if (!interactive) throw new Error(`connection ${c.name} needs login; use /connections login ${c.name}`);
      interactive.show(url.href);
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error("OAuth login expired; start login again"); return verifier; },
    invalidateCredentials: scope => save(c, scope === "client" ? { client: undefined } : scope === "tokens" ? { tokens: undefined } : { client: undefined, tokens: undefined }),
  };
}
export async function loginConnection(c: ConfiguredConnection, show: (url: string) => void, signal?: AbortSignal): Promise<void> {
  if (c.transport !== "http" || !c.oauth) throw new Error("enable OAuth on an HTTP connection before login");
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const state = crypto.randomUUID();
  let resolve!: (code: string) => void, reject!: (error: unknown) => void;
  const code = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void code.catch(() => {});
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) return new Response("Invalid callback", { status: 400 });
    if (u.searchParams.has("error")) { reject(new Error("Authorization was declined")); return new Response("Login cancelled"); }
    const value = u.searchParams.get("code");
    if (!value) return new Response("Missing code", { status: 400 });
    resolve(value); return new Response("Connected. You can return to Orca.", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }});
  const cancelled = () => reject(abort.reason);
  abort.addEventListener("abort", cancelled, { once: true });
  try {
    abort.throwIfAborted();
    const provider = await oauthProvider(c, { redirect: `http://127.0.0.1:${server.port}/callback`, state, show });
    const fetchFn = (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([abort, init.signal]) : abort });
    if (await auth(provider, { serverUrl: c.url!, fetchFn }) === "REDIRECT") await auth(provider, { serverUrl: c.url!, authorizationCode: await code, fetchFn });
  } finally { abort.removeEventListener("abort", cancelled); server.stop(true); }
}
