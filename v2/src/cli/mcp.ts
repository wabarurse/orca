import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fail, ok, type Result } from "../config";
import { disconnectServers, EXAMPLE, loginServer, logoutServer, readServers, signedIn, usableServer, withServer, type Entry } from "../core/mcp";

export const MCP_USAGE = `orca2 mcp                 list the servers in ~/.orca2/mcp.json (creates the file if missing)
  orca2 mcp test [name]     connect and count each server's tools
  orca2 mcp login <name>    sign in to a url server in the browser
  orca2 mcp logout <name>   forget that sign-in`;

const given = (value: string | null | undefined): value is string => typeof value === "string" && value !== "";

async function describe(entry: Entry): Promise<string> {
  const server = entry.server ?? null;
  const how = server === null ? "" : given(server.command) ? [server.command, ...server.args].join(" ") : server.url ?? "";
  const signed = server !== null && given(server.url) && await signedIn(server);
  const state = entry.disabled ? "disabled" : given(entry.problem) ? `not usable: ${entry.problem}` : signed ? "ready, signed in" : "ready";
  return `  ${entry.name.padEnd(16)} ${state}${how !== "" ? `\n  ${"".padEnd(16)} ${how}` : ""}`;
}

async function test(name: string): Promise<string> {
  const listed = await withServer(name, process.cwd(), undefined, async (client, options) => (await client.listTools({}, options)).tools);
  if (!listed.ok) return `  ${name.padEnd(16)} failed: ${listed.error}`;
  const tools = listed.data;
  return `  ${name.padEnd(16)} connected, ${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length > 0 ? `: ${tools.slice(0, 8).map(t => t.name).join(", ")}${tools.length > 8 ? ", …" : ""}` : ""}`;
}

async function act(action: string, name: string | undefined, out: (line: string) => void): Promise<Result<null>> {
  const { path, entries, problem } = readServers();
  if (action === "list") {
    if (!existsSync(path)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, EXAMPLE, { flag: "wx" }); }
    out(`MCP servers in ${path}`);
    if (given(problem)) return fail(problem);
    for (const entry of entries) out(await describe(entry));
    if (entries.length === 0) out(`  none yet. Add one inside "mcpServers", for example:\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }`);
    return ok(null);
  }
  if (action === "test") {
    if (given(problem)) return fail(problem);
    const names = given(name) ? [name] : entries.filter(e => !e.disabled).map(e => e.name);
    if (names.length === 0) out("  nothing to test: no enabled servers");
    for (const each of names) out(await test(each));
    return ok(null);
  }
  if ((action === "login" || action === "logout") && given(name)) {
    const server = usableServer(name);
    if (!server.ok) return server;
    if (action === "logout") { await disconnectServers(name); await logoutServer(server.data); out(`${name}: signed out`); return ok(null); }
    const signed = await loginServer(server.data, url => out(`Open this address to sign in to ${name}:\n${url}`));
    if (!signed.ok) return signed;
    out(`${name}: signed in`);
    return ok(null);
  }
  return fail(`usage:\n  ${MCP_USAGE}`);
}

export async function runMcp(args: string[], out: (line: string) => void = console.log): Promise<number> {
  const [action = "list", name] = args;
  try {
    const done = await act(action, name, out);
    if (done.ok) return 0;
    out(done.error);
    return done.error.startsWith("usage:") ? 2 : 1;
  } finally { await disconnectServers(); }
}
