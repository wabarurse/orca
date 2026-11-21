import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { serverKey, usableServer, type Server } from "./config";
import { errorMessage } from "../result";
import { oauthProvider } from "./auth";

export const IDLE_MS = 10 * 60_000;
export const CONNECT_MS = 60_000;
export class UsageError extends Error {}

type Live = { server: Server; client: Client; transport: Transport; ready: Promise<void>; users: number; timer: ReturnType<typeof setTimeout> | undefined };
const live = new Map<string, Live>();
const close = async (key: string, item: Live) => { if (live.get(key) === item) live.delete(key); clearTimeout(item.timer); await item.client.close().catch(() => {}); };

export async function disconnectServers(name?: string): Promise<void> {
  await Promise.all([...live].filter(([, item]) => name === undefined || name === "" || item.server.name === name).map(([key, item]) => close(key, item)));
}
export const connected = (name: string) => [...live.values()].some(item => item.server.name === name);
process.on("exit", () => { for (const item of live.values()) if (item.transport instanceof StdioClientTransport && item.transport.pid !== null && item.transport.pid > 0) {
  try { process.kill(item.transport.pid, "SIGTERM"); } catch {}
} });

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
    const own = Object.keys(server.headers).some(name => name.toLowerCase() === "authorization");
    transport = new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
      authProvider: own ? undefined : oauthProvider(server),
      requestInit: { headers: server.headers },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  }
  const client = new Client({ name: "orca2", version: "1.0.0" }, { capabilities: {} });
  const ready = client.connect(transport, { timeout: CONNECT_MS }).catch((error: unknown) => {
    const output = said();
    throw new Error(`could not connect to MCP server ${server.name}: ${errorMessage(error)}${output !== "" ? `\nits output:\n${output}` : ""}`);
  });
  void ready.catch(() => {});
  return { server, client, transport, ready, users: 0, timer: undefined };
}

export async function withServer<T>(name: string, cwd: string, signal: AbortSignal | undefined,
  action: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
  const server = usableServer(name);
  signal?.throwIfAborted();
  const key = `${serverKey(server)}:${cwd}`;
  for (const [old, item] of live) if (item.server.name === name && old !== key && item.users === 0) await close(old, item);
  let item = live.get(key);
  if (item === undefined) {
    const opened = item = open(server, cwd);
    live.set(key, opened);
    opened.client.onclose = () => { if (live.get(key) === opened) { clearTimeout(opened.timer); live.delete(key); } };
  }
  const current = item;
  clearTimeout(current.timer); current.users++;
  const cancelled = () => { void close(key, current).catch(() => {}); };
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    await current.ready;
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(server.timeoutMs);
    return await action(current.client, { signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout, timeout: server.timeoutMs });
  } catch (error) {
    const answered = error instanceof UsageError || error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout;
    if (!answered) await close(key, current);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelled); current.users--;
    if (current.users === 0 && live.get(key) === current) {
      current.timer = setTimeout(() => { void close(key, current).catch(() => {}); }, IDLE_MS);
      current.timer.unref();
    }
  }
}
