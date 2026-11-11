import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectionKey, listConnections, type ConfiguredConnection } from "./config";
import { oauthProvider } from "./auth";

interface Live { definition: ConfiguredConnection; client: Client; transport: Transport; ready: Promise<void>; users: number; timer?: ReturnType<typeof setTimeout> }
const live = new Map<string, Live>();
export async function disconnectConnections(name?: string): Promise<void> {
  await Promise.all([...live.entries()].filter(([, p]) => !name || p.definition.name === name).map(async ([key, p]) => {
    live.delete(key); clearTimeout(p.timer); await p.client.close().catch(() => {});
  }));
}
// Only the direct children created by this process are signalled on hard exit.
// Normal shutdown uses the SDK's bounded TERM/KILL cleanup; remote servers are never killed.
process.on("exit", () => { for (const p of live.values()) if (p.transport instanceof StdioClientTransport && p.transport.pid) {
  try { process.kill(p.transport.pid, "SIGTERM"); } catch { /* already exited */ }
} });
export function connectionStatus(c: ConfiguredConnection): string {
  if (!c.enabled) return "disabled";
  return [...live.values()].some(p => connectionKey(p.definition) === connectionKey(c)) ? "connected in this process" : "available on demand";
}
export async function withConnection<T>(project: string | undefined, name: string, cwd: string, signal: AbortSignal | undefined,
  action: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
  const c = listConnections(project).find(c => c.name === name);
  if (!c) throw new Error(`unknown MCP connection: ${name}`);
  if (!c.enabled) throw new Error(`MCP connection ${name} is disabled`);
  const timeout = c.timeoutMs ?? 60000;
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  abort.throwIfAborted();
  const key = `${connectionKey(c)}:${cwd}`;
  let p = live.get(key);
  if (!p) {
    // Closing an edited connection never retries an operation sent through it.
    for (const [old, item] of live) if (item.definition.scope === c.scope && item.definition.name === c.name && old !== key && !item.users) {
      live.delete(old); clearTimeout(item.timer); await item.client.close().catch(() => {});
    }
    let transport: Transport;
    if (c.transport === "stdio") {
      const env = getDefaultEnvironment();
      for (const name of c.env ?? []) {
        const value = process.env[name]; if (value === undefined) throw new Error(`missing local environment variable: ${name}`); env[name] = value;
      }
      transport = new StdioClientTransport({ command: c.command!, args: c.args, env, cwd, stderr: "ignore" });
    } else {
      const token = c.tokenEnv ? process.env[c.tokenEnv] : undefined;
      if (c.tokenEnv && !token) throw new Error(`missing local environment variable: ${c.tokenEnv}`);
      transport = new StreamableHTTPClientTransport(new URL(c.url!), {
        authProvider: c.oauth ? await oauthProvider(c) : undefined,
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
    }
    const client = new Client({ name: "orca", version: "1.0.0" }, { capabilities: {} });
    p = { definition: c, client, transport, users: 0, ready: client.connect(transport, { signal: abort, timeout }) };
    live.set(key, p);
    client.onclose = () => { if (live.get(key) === p) { clearTimeout(p?.timer); live.delete(key); } };
    void p.ready.catch(() => {});
  }
  const current = p;
  clearTimeout(current.timer); current.users++;
  const cancelled = () => { if (live.get(key) === current) live.delete(key); void current.client.close(); };
  abort.addEventListener("abort", cancelled, { once: true });
  try { await current.ready; abort.throwIfAborted(); return await action(current.client, { signal: abort, timeout }); }
  catch (error) {
    if (live.get(key) === current) live.delete(key);
    await current.client.close().catch(() => {});
    // No reconnect-and-retry of calls: a disconnected mutation may have succeeded.
    throw error;
  } finally {
    abort.removeEventListener("abort", cancelled); current.users--;
    if (!current.users && live.get(key) === current) {
      current.timer = setTimeout(() => { live.delete(key); void current.client.close(); }, 30000);
      current.timer.unref();
    }
  }
}
