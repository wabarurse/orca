import { createHash } from "node:crypto";
import { paths, directoryProject, readState, updateState } from "../../config";

export interface Connection {
  name: string; transport: "stdio" | "http"; enabled: boolean;
  url?: string; command?: string; args?: string[];
  /** Names of local environment variables, never their secret values. */
  env?: string[]; tokenEnv?: string; oauth?: boolean; timeoutMs?: number;
}
export interface ConfiguredConnection extends Connection { scope: string }
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function checkedConnection(input: unknown): Connection {
  const c = input as Connection;
  if (!c || !namePattern.test(c.name) || !["stdio", "http"].includes(c.transport) || typeof c.enabled !== "boolean") throw new Error("connection needs name, transport (stdio/http) and enabled");
  if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 600000)) throw new Error("timeoutMs must be 1000–600000");
  if (c.transport === "http") {
    const u = new URL(c.url ?? "");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new Error("remote MCP connections require HTTPS; HTTP is allowed on loopback");
    if (u.username || u.password || u.hash || u.search) throw new Error("put credentials in a local environment variable, not the server URL");
    if (c.tokenEnv && !variable.test(c.tokenEnv)) throw new Error("invalid token environment variable");
    if (c.oauth !== undefined && typeof c.oauth !== "boolean") throw new Error("oauth must be boolean");
    if (c.oauth && c.tokenEnv) throw new Error("choose OAuth or a bearer token environment variable");
    return { name: c.name, transport: c.transport, enabled: c.enabled, url: u.href, tokenEnv: c.tokenEnv, oauth: c.oauth, timeoutMs: c.timeoutMs };
  }
  if (!c.command?.trim() || /[\x00\r\n]/.test(c.command) || (c.args && (!Array.isArray(c.args) || c.args.some(a => typeof a !== "string" || a.includes("\0"))))) throw new Error("stdio requires an executable and an array of arguments; no shell command string");
  if (c.env && (!Array.isArray(c.env) || c.env.some(e => !variable.test(e)))) throw new Error("env must contain environment variable names");
  return { name: c.name, transport: c.transport, enabled: c.enabled, command: c.command, args: c.args ?? [], env: c.env ?? [], timeoutMs: c.timeoutMs };
}
export function connectionScope(project?: string): string {
  if (!project) return "connections:global";
  const directory = directoryProject(paths.memory, project);
  if (!directory) throw new Error("open a directory project before adding a project connection");
  return `connections:project:${directory.id}`;
}
export function listConnections(project?: string): ConfiguredConnection[] {
  const scopes = [connectionScope(), ...(project ? [connectionScope(project)] : [])];
  const merged = new Map<string, ConfiguredConnection>();
  for (const scope of scopes) for (const c of readState<Connection[]>(paths.memory, scope, "definitions") ?? []) {
    merged.set(c.name, { ...checkedConnection(c), scope });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function saveConnection(input: unknown, project?: string): void {
  const c = checkedConnection(input);
  updateState<Connection[]>(paths.memory, connectionScope(project), "definitions", old => [...(old ?? []).filter(o => o.name !== c.name), c]);
}
export function removeConnection(name: string, project?: string): void {
  updateState<Connection[]>(paths.memory, connectionScope(project), "definitions", old => (old ?? []).filter(c => c.name !== name));
}
export function connectionKey(c: ConfiguredConnection): string {
  return createHash("sha256").update(JSON.stringify([c.scope, c.name, c.transport, c.url, c.command, c.args, c.env, c.tokenEnv, c.oauth])).digest("hex");
}
