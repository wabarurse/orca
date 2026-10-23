import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds, matching Claude Code's credential format. */
  expiresAt: number;
}

export function validateProfile(profile: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile) || profile === "env") {
    throw new Error("profile must be 1–64 letters, numbers, dots, underscores or hyphens, start with a letter or number, and not be 'env'.");
  }
  return profile;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function writeTokens(path: string, tokens: unknown, signal?: AbortSignal): Promise<void> {
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
export async function withCredentialLock<T>(path: string, action: () => Promise<T>): Promise<T> {
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
      if (Date.now() >= deadline) throw new Error(`subscription credential lock timed out: ${lock}. if a process was killed, stop the agents and remove this lock directory before retrying.`);
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

export interface LoginOptions {
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

export interface OAuthLoginConfig {
  label: string;
  authorizeURL: string;
  clientId: string;
  scope: string;
  port: number;
  callbackPath: string;
  extraParams?: Record<string, string>;
  exchange: (body: Record<string, string>, fetcher: Fetch, signal: AbortSignal) => Promise<void>;
}

/** Browser PKCE login with state validation and a loopback-only callback. */
export async function loginOAuth(config: OAuthLoginConfig, options: LoginOptions): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const result = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let received = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? config.port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== config.callbackPath) return new Response("not found", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("invalid oauth state", { status: 400 });
      if (received) return new Response("login already received", { status: 409 });
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        result.reject(new Error(`${config.label} login was cancelled or denied; try logging in again.`));
        return new Response("login was not completed.", { status: 400 });
      }
      received = true;
      try {
        await config.exchange({ grant_type: "authorization_code", code, state, code_verifier: verifier, redirect_uri: redirectUri }, options.fetcher ?? fetch, cancellation.signal);
        result.resolve();
        return new Response("signed in to parallels. you can close this tab.");
      } catch (err) {
        result.reject(err);
        return new Response("login failed. return to parallels and try again.", { status: 400 });
      }
    },
  });
  const redirectUri = `http://localhost:${server.port}${config.callbackPath}`;
  const url = new URL(config.authorizeURL);
  url.search = new URLSearchParams({
    ...config.extraParams, client_id: config.clientId, response_type: "code", scope: config.scope,
    code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: redirectUri,
  }).toString();
  const fail = (message: string) => {
    const error = new Error(message);
    cancellation.abort(error);
    result.reject(error);
  };
  const cancel = () => fail(`${config.label} login cancelled.`);
  const timer = setTimeout(() => fail(`${config.label} login timed out; try logging in again.`), 5 * 60_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    else {
      options.write(`sign in with your ${config.label} subscription in your browser:\n${url}\nwaiting for login…`);
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
