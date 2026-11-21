import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paths } from "../../config";
import { fail, ok, type Result } from "../result";

export class CredentialError extends Error {
  constructor(readonly reason: "credentials-invalid" | "credential-lock" | "oauth-connection" | "oauth-http" | "oauth-response",
    message: string, readonly oauthStatus?: number) {
    super(message);
    this.name = "CredentialError";
  }
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export function parseProfile(profile: string): Result<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile) || profile === "env") {
    return fail("profile must be 1–64 letters, numbers, dots, underscores or hyphens, start with a letter or number, and not be 'env'.");
  }
  return ok(profile);
}

export function validateProfile(profile: string): string {
  const parsed = parseProfile(profile);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

const errnoShape = z.object({ code: z.string() });
export function errnoCode(error: unknown): string | undefined {
  const parsed = errnoShape.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function writeTokens(path: string, tokens: unknown, signal?: AbortSignal): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
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

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return errnoCode(err) === "EPERM"; }
}

export async function breakStaleLock(lock: string): Promise<boolean> {
  let pid: number;
  try { pid = Number((await Bun.file(join(lock, "pid")).text()).trim()); }
  catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) return false;
  const staging = `${lock}.stale-${process.pid}-${Date.now()}`;
  try { await rename(lock, staging); }
  catch { return false; }
  await rm(staging, { recursive: true, force: true });
  return true;
}

export async function withCredentialLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
      if (await breakStaleLock(lock)) continue;
      if (Date.now() >= deadline) throw new CredentialError("credential-lock", `subscription credential lock timed out: ${lock}. if a process was killed, stop the agents and remove this lock directory before retrying.`);
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

export type LoginOptions = {
  write: (text: string) => void;
  openBrowser?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
  port?: number;
  fetcher?: Fetch;
};

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  try { Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref(); } catch { }
}

export type OAuthLoginConfig = {
  label: string;
  authorizeURL: string;
  clientId: string;
  scope: string;
  port: number;
  callbackPath: string;
  extraParams?: Record<string, string>;
  exchange: (body: Record<string, string>, fetcher: Fetch, signal: AbortSignal) => Promise<void>;
};

function isShortLink(request: Request, url: URL, nonce: string): boolean {
  return request.method === "GET" && url.pathname === `/login/${nonce}`;
}

async function writeLoginUrlFile(path: string, url: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await rm(path, { force: true });
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(url + "\n"); } finally { await file.close(); }
    return true;
  } catch {
    await rm(path, { force: true }).catch(() => {});
    return false;
  }
}

const present = (value: string | undefined): boolean => value !== undefined && value !== "";

function loginMessage(label: string, shortLink: string, port: number | undefined, urlFile?: string): string {
  const lines = [`sign in with your ${label} subscription in your browser:`, shortLink];
  if (present(process.env.SSH_CONNECTION) || present(process.env.SSH_TTY)) lines.push(`over ssh, first run: ssh -L ${port}:localhost:${port} <this-host>`);
  if (urlFile !== undefined && urlFile !== "") lines.push(`if the link does not work, the full url is in ${urlFile}`);
  lines.push("waiting for login…");
  return lines.join("\n");
}

export async function loginOAuth(config: OAuthLoginConfig, options: LoginOptions): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const result = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let received = false;
  const nonce = randomBytes(6).toString("base64url");
  let authorizeURL = "";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? config.port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (isShortLink(request, url, nonce)) return new Response(null, { status: 302, headers: { location: authorizeURL } });
      if (request.method !== "GET" || url.pathname !== config.callbackPath) return new Response("not found", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("invalid oauth state", { status: 400 });
      if (received) return new Response("login already received", { status: 409 });
      const code = url.searchParams.get("code");
      if (code === null || code === "" || url.searchParams.has("error")) {
        result.reject(new Error(`${config.label} login was cancelled or denied; try logging in again.`));
        return new Response("login was not completed.", { status: 400 });
      }
      received = true;
      try {
        await config.exchange({ grant_type: "authorization_code", code, state, code_verifier: verifier, redirect_uri: redirectUri }, options.fetcher ?? fetch, cancellation.signal);
        result.resolve();
        return new Response("signed in to orca. you can close this tab.");
      } catch (err) {
        result.reject(err);
        return new Response("login failed. return to orca and try again.", { status: 400 });
      }
    },
  });
  const redirectUri = `http://localhost:${server.port}${config.callbackPath}`;
  const url = new URL(config.authorizeURL);
  url.search = new URLSearchParams({
    ...config.extraParams, client_id: config.clientId, response_type: "code", scope: config.scope,
    code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: redirectUri,
  }).toString();
  authorizeURL = url.toString();
  const shortLink = `http://localhost:${server.port}/login/${nonce}`;
  const urlFile = join(paths.runtime, "login-url.txt");
  let urlFileAttempted = false;
  const fail = (message: string) => {
    const error = new Error(message);
    cancellation.abort(error);
    result.reject(error);
  };
  const cancel = () => fail(`${config.label} login cancelled.`);
  const timer = setTimeout(() => fail(`${config.label} login timed out; try logging in again.`), 5 * 60_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted === true) cancel();
    else {
      urlFileAttempted = true;
      const savedUrl = await writeLoginUrlFile(urlFile, authorizeURL);
      options.write(loginMessage(config.label, shortLink, server.port, savedUrl ? urlFile : undefined));
      void Promise.resolve().then(() => (options.openBrowser ?? openBrowser)(authorizeURL)).catch(() => {});
    }
    await result.promise;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await server.stop();
    if (urlFileAttempted) await rm(urlFile, { force: true }).catch(() => {});
  }
}
