import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { asRecord, fail, ok, parseJson, paths, type Result } from "../../config";

export type Server = {
  name: string;
  command?: string; args: string[]; env: Record<string, string>;
  url?: string; headers: Record<string, string>;
  timeoutMs: number;
};
export type Entry = { name: string; disabled: boolean; server?: Server; problem?: string };

export const DEFAULT_TIMEOUT_S = 60;
export const EXAMPLE = `{
  "mcpServers": {
  }
}
`;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEYS = ["command", "args", "env", "url", "headers", "disabled", "timeout", "type"];
const StringMap = z.record(z.string(), z.string());
const StringList = z.array(z.string());

function expand(text: string, where: string): Result<string> {
  let missing: string | null = null;
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = process.env[name];
    if (value === undefined) { missing ??= name; return whole; }
    return value;
  });
  return missing === null ? ok(out) : fail(`${where} uses \${${missing}}, which is not set in the environment orca2 was started from`);
}
function expandAll(values: Record<string, string>, where: string): Result<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const expanded = expand(value, `${where}.${key}`);
    if (!expanded.ok) return expanded;
    out[key] = expanded.data;
  }
  return ok(out);
}
function expandList(values: string[], where: string): Result<string[]> {
  const out: string[] = [];
  for (const value of values) {
    const expanded = expand(value, where);
    if (!expanded.ok) return expanded;
    out.push(expanded.data);
  }
  return ok(out);
}

function server(name: string, raw: unknown): Result<Server> {
  const entry = asRecord(raw);
  if (entry === null) return fail("must be an object with a command or a url");
  const unknown = Object.keys(entry).filter(key => !KEYS.includes(key));
  if (unknown.length > 0) return fail(`unknown setting ${unknown.map(key => `"${key}"`).join(", ")}; use ${KEYS.slice(0, 7).join(", ")}`);
  const { command, url, args = [], env = {}, headers = {}, timeout = DEFAULT_TIMEOUT_S, type } = entry;
  if ((command === undefined) === (url === undefined)) return fail("needs either a command (a local program) or a url, not both");
  if (type === "sse") return fail("the old SSE transport is not supported; use the server's Streamable HTTP url");
  if (type !== undefined && type !== (command !== undefined ? "stdio" : "http") && type !== "streamable-http") return fail(`type "${String(type)}" does not match this entry; remove it`);
  if (typeof timeout !== "number" || !(timeout >= 1 && timeout <= 600)) return fail("timeout is in seconds, 1 to 600");
  const envMap = StringMap.safeParse(env), headerMap = StringMap.safeParse(headers);
  if (!envMap.success) return fail('env must look like { "NAME": "value" }');
  if (!headerMap.success) return fail('headers must look like { "Name": "value" }');
  const timeoutMs = Math.round(timeout * 1000);
  if (command !== undefined) {
    if (typeof command !== "string" || command.trim() === "" || /[\x00\r\n]/.test(command)) return fail("command must be the program to run");
    const list = StringList.safeParse(args);
    if (!list.success || list.data.some(arg => arg.includes("\0"))) return fail('args must be a list of strings, one per argument: ["-y", "package"]');
    if (Object.keys(headerMap.data).length > 0) return fail("headers apply to a url, not a command");
    const expandedArgs = expandList(list.data, "args");
    if (!expandedArgs.ok) return expandedArgs;
    const expandedEnv = expandAll(envMap.data, "env");
    if (!expandedEnv.ok) return expandedEnv;
    return ok({ name, command, args: expandedArgs.data, env: expandedEnv.data, headers: {}, timeoutMs });
  }
  if (typeof url !== "string") return fail("url must be a string");
  if ((Array.isArray(args) && args.length > 0) || Object.keys(envMap.data).length > 0) return fail("args and env apply to a command, not a url");
  const expandedUrl = expand(url, "url");
  if (!expandedUrl.ok) return expandedUrl;
  if (!URL.canParse(expandedUrl.data)) return fail(`url is not a web address: ${url}`);
  const parsed = new URL(expandedUrl.data);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return fail("url must be https (http is allowed for localhost)");
  if (parsed.username !== "" || parsed.password !== "") return fail('put a token in headers ("Authorization": "Bearer ${TOKEN}"), not in the url');
  const expandedHeaders = expandAll(headerMap.data, "headers");
  if (!expandedHeaders.ok) return expandedHeaders;
  return ok({ name, url: parsed.href, args: [], env: {}, headers: expandedHeaders.data, timeoutMs });
}

function entry(name: string, value: unknown): Entry {
  const disabling = asRecord(value)?.disabled;
  const disabled = disabling === true;
  if (!NAME.test(name)) return { name, disabled, problem: "a name is letters, digits, - and _ (64 at most)" };
  if (disabling !== undefined && typeof disabling !== "boolean") return { name, disabled, problem: "disabled must be true or false" };
  if (disabled) return { name, disabled };
  const parsed = server(name, value);
  return parsed.ok ? { name, disabled, server: parsed.data } : { name, disabled, problem: parsed.error };
}

export function readServers(): { path: string; entries: Entry[]; problem?: string } {
  const path = paths.mcp;
  if (!existsSync(path)) return { path, entries: [] };
  const raw = parseJson(readFileSync(path, "utf8"));
  if (!raw.ok) return { path, entries: [], problem: `${path} is not valid JSON: ${raw.error}` };
  const servers = asRecord(asRecord(raw.data)?.mcpServers);
  if (servers === null) return { path, entries: [], problem: `${path} needs a top-level "mcpServers" object` };
  return { path, entries: Object.entries(servers).map(([name, value]) => entry(name, value)) };
}

export function usableServer(name: string): Result<Server> {
  const { path, entries, problem } = readServers();
  if (problem !== undefined) return fail(problem);
  const found = entries.find(candidate => candidate.name === name);
  if (found === undefined) return fail(`no MCP server named ${name} in ${path}${entries.length > 0 ? ` (it has: ${entries.map(e => e.name).join(", ")})` : ""}`);
  if (found.disabled) return fail(`MCP server ${name} is disabled in ${path}`);
  if (found.server === undefined) return fail(`MCP server ${name} in ${path}: ${found.problem ?? "unusable"}`);
  return ok(found.server);
}

export const serverKey = (s: Server) => createHash("sha256").update(JSON.stringify([s.name, s.command, s.args, s.env, s.url, s.headers])).digest("hex");
export const loginKey = (s: Pick<Server, "name" | "url">) => createHash("sha256").update(JSON.stringify([s.name, s.url])).digest("hex");
