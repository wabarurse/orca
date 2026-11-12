// The user's MCP servers, from one file they edit by hand: ~/.orca/mcp.json.
//
//   {
//     "mcpServers": {
//       "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
//       "linear":  { "url": "https://mcp.linear.app/mcp" },
//       "private": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }, "disabled": true }
//     }
//   }
//
// `command` starts a local program; `url` reaches a server over HTTP. This is the `mcpServers`
// shape other MCP clients use, so an entry from a server's README can be pasted in. The file is
// read again for every use, so an edit applies to the next call with no restart. A mistake in
// one entry disables that entry only, and says why.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { paths } from "../../config";

export interface Server {
  name: string;
  /** Exactly one of `command` (a local program) and `url` (HTTP). */
  command?: string; args: string[]; env: Record<string, string>;
  url?: string; headers: Record<string, string>;
  timeoutMs: number;
}
/** One entry as written: usable (`server`), switched off, or wrong (`problem`). */
export interface Entry { name: string; disabled: boolean; server?: Server; problem?: string }

export const DEFAULT_TIMEOUT_S = 60;
export const EXAMPLE = `{
  "mcpServers": {
  }
}
`;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEYS = ["command", "args", "env", "url", "headers", "disabled", "timeout", "type"];
const strings = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string");

/** `${NAME}` is replaced by that environment variable, so a token need not be written in the file. */
function expand(text: string, where: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`${where} uses \${${name}}, which is not set in the environment orca was started from`);
    return value;
  });
}
const expandAll = (values: Record<string, string>, where: string) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value, `${where}.${key}`)]));

function server(name: string, raw: unknown): Server {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("must be an object with a command or a url");
  const entry = raw as Record<string, unknown>;
  const unknown = Object.keys(entry).filter(key => !KEYS.includes(key));
  if (unknown.length) throw new Error(`unknown setting ${unknown.map(key => `"${key}"`).join(", ")}; use ${KEYS.slice(0, 7).join(", ")}`);
  const { command, url, args = [], env = {}, headers = {}, timeout = DEFAULT_TIMEOUT_S, type } = entry;
  if ((command === undefined) === (url === undefined)) throw new Error("needs either a command (a local program) or a url, not both");
  if (type === "sse") throw new Error("the old SSE transport is not supported; use the server's Streamable HTTP url");
  if (type !== undefined && type !== (command !== undefined ? "stdio" : "http") && type !== "streamable-http") throw new Error(`type "${type}" does not match this entry; remove it`);
  if (typeof timeout !== "number" || !(timeout >= 1 && timeout <= 600)) throw new Error("timeout is in seconds, 1 to 600");
  if (!strings(env)) throw new Error('env must look like { "NAME": "value" }');
  if (!strings(headers)) throw new Error('headers must look like { "Name": "value" }');
  const timeoutMs = Math.round(timeout * 1000);
  if (command !== undefined) {
    if (typeof command !== "string" || !command.trim() || /[\x00\r\n]/.test(command)) throw new Error("command must be the program to run");
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error('args must be a list of strings, one per argument: ["-y", "package"]');
    if (Object.keys(headers).length) throw new Error("headers apply to a url, not a command");
    return { name, command, args: args.map(arg => expand(arg as string, "args")), env: expandAll(env, "env"), headers: {}, timeoutMs };
  }
  if (typeof url !== "string") throw new Error("url must be a string");
  if (Array.isArray(args) && args.length || Object.keys(env).length) throw new Error("args and env apply to a command, not a url");
  let parsed: URL;
  try { parsed = new URL(expand(url, "url")); } catch (error) { throw new Error(error instanceof TypeError ? `url is not a web address: ${url}` : (error as Error).message); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("url must be https (http is allowed for localhost)");
  if (parsed.username || parsed.password) throw new Error('put a token in headers ("Authorization": "Bearer ${TOKEN}"), not in the url');
  return { name, url: parsed.href, args: [], env: {}, headers: expandAll(headers, "headers"), timeoutMs };
}

/** Every entry in the file, in the order written. A file that cannot be read as a whole is one problem for the caller to show. */
export function readServers(): { path: string; entries: Entry[]; problem?: string } {
  const path = paths.mcp;
  if (!existsSync(path)) return { path, entries: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { return { path, entries: [], problem: `${path} is not valid JSON: ${error instanceof Error ? error.message : error}` }; }
  const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { path, entries: [], problem: `${path} needs a top-level "mcpServers" object` };
  return { path, entries: Object.entries(servers).map(([name, value]) => {
    const disabled = (value as { disabled?: unknown } | null)?.disabled === true;
    try {
      if (!NAME.test(name)) throw new Error("a name is letters, digits, - and _ (64 at most)");
      const disabling = (value as { disabled?: unknown } | null)?.disabled;
      if (disabling !== undefined && typeof disabling !== "boolean") throw new Error("disabled must be true or false");
      // A disabled entry may name a variable that is not set: it is not going to be used.
      return disabled ? { name, disabled } : { name, disabled, server: server(name, value) };
    } catch (error) { return { name, disabled, problem: error instanceof Error ? error.message : String(error) }; }
  }) };
}

/** The server to use for `name`, or the reason it cannot be used, as the user should read it. */
export function usableServer(name: string): Server {
  const { path, entries, problem } = readServers();
  if (problem) throw new Error(problem);
  const entry = entries.find(candidate => candidate.name === name);
  if (!entry) throw new Error(`no MCP server named ${name} in ${path}${entries.length ? ` (it has: ${entries.map(e => e.name).join(", ")})` : ""}`);
  if (entry.disabled) throw new Error(`MCP server ${name} is disabled in ${path}`);
  if (!entry.server) throw new Error(`MCP server ${name} in ${path}: ${entry.problem}`);
  return entry.server;
}

/** Changes whenever anything about how the server is reached changes: a running connection is not reused across an edit. */
export const serverKey = (s: Server) => createHash("sha256").update(JSON.stringify([s.name, s.command, s.args, s.env, s.url, s.headers])).digest("hex");
/** A sign-in belongs to the server's name and address; changing a header or the timeout keeps it. */
export const loginKey = (s: Pick<Server, "name" | "url">) => createHash("sha256").update(JSON.stringify([s.name, s.url])).digest("hex");
