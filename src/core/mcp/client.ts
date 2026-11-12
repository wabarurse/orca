// Connections to the user's MCP servers, opened on first use and shared by later calls in this
// process. A local server keeps running between calls (many hold state: a browser, a session)
// and is closed after IDLE_MS without use, when its entry in mcp.json changes, or when the
// connection itself fails. A request the server merely refuses leaves it running.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { serverKey, usableServer, type Server } from "./config";
import { oauthProvider } from "./auth";

export const IDLE_MS = 10 * 60_000;
/** Starting a local server may download it first (`npx`), so this is separate from a call's own timeout. */
export const CONNECT_MS = 60_000;
/** A mistake in what was asked (a missing name, a wrong argument): nothing is wrong with the connection. */
export class UsageError extends Error {}

interface Live { server: Server; client: Client; transport: Transport; ready: Promise<void>; users: number; timer?: ReturnType<typeof setTimeout> }
const live = new Map<string, Live>();
const close = async (key: string, item: Live) => { if (live.get(key) === item) live.delete(key); clearTimeout(item.timer); await item.client.close().catch(() => {}); };

export async function disconnectServers(name?: string): Promise<void> {
  await Promise.all([...live].filter(([, item]) => !name || item.server.name === name).map(([key, item]) => close(key, item)));
}
/** Whether this process holds a connection to the server. */
export const connected = (name: string) => [...live.values()].some(item => item.server.name === name);
// Only the direct children created by this process are signalled on hard exit.
// Normal shutdown uses the SDK's bounded TERM/KILL cleanup; remote servers are never killed.
process.on("exit", () => { for (const item of live.values()) if (item.transport instanceof StdioClientTransport && item.transport.pid) {
  try { process.kill(item.transport.pid, "SIGTERM"); } catch { /* already exited */ }
} });

/** The last of what a local server wrote to stderr: the only place it says why it could not start. */
function stderrTail(transport: StdioClientTransport): () => string {
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-2000); });
  return () => tail.trim();
}

function open(server: Server, cwd: string): Live {
  let transport: Transport, said = () => "";
  if (server.command !== undefined) {
    const local = new StdioClientTransport({ command: server.command, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, cwd, stderr: "pipe" });
    said = stderrTail(local); transport = local;
  } else {
    // With no Authorization header of its own, a server that asks for a sign-in gets the saved OAuth one.
    const own = Object.keys(server.headers).some(name => name.toLowerCase() === "authorization");
    transport = new StreamableHTTPClientTransport(new URL(server.url!), {
      authProvider: own ? undefined : oauthProvider(server),
      requestInit: { headers: server.headers },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  }
  const client = new Client({ name: "orca", version: "1.0.0" }, { capabilities: {} });
  const ready = client.connect(transport, { timeout: CONNECT_MS }).catch(error => {
    const output = said();
    throw new Error(`could not connect to MCP server ${server.name}: ${error instanceof Error ? error.message : error}${output ? `\nits output:\n${output}` : ""}`);
  });
  void ready.catch(() => {});
  return { server, client, transport, ready, users: 0 };
}

/** Run `action` on the named server's connection, opening it if needed. Nothing is retried: a call that failed may still have had its effect. */
export async function withServer<T>(name: string, cwd: string, signal: AbortSignal | undefined,
  action: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
  const server = usableServer(name);
  signal?.throwIfAborted();
  const key = `${serverKey(server)}:${cwd}`;
  // An edited entry gets a new connection; the old one goes once nothing is using it.
  for (const [old, item] of live) if (item.server.name === name && old !== key && !item.users) await close(old, item);
  let item = live.get(key);
  if (!item) {
    const opened = item = open(server, cwd);
    live.set(key, opened);
    opened.client.onclose = () => { if (live.get(key) === opened) { clearTimeout(opened.timer); live.delete(key); } };
  }
  const current = item;
  clearTimeout(current.timer); current.users++;
  const cancelled = () => { void close(key, current); };
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    await current.ready;
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(server.timeoutMs);
    return await action(current.client, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout: server.timeoutMs });
  } catch (error) {
    // The server answering "no" (an unknown tool, bad arguments) is an answer; anything else may have broken the connection.
    const answered = error instanceof UsageError || error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout;
    if (!answered) await close(key, current);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelled); current.users--;
    if (!current.users && live.get(key) === current) {
      current.timer = setTimeout(() => { void close(key, current); }, IDLE_MS);
      current.timer.unref();
    }
  }
}
