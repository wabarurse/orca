import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { disconnectServers, EXAMPLE, loginServer, logoutServer, readServers, signedIn, usableServer, withServer, type Entry } from "../core/mcp";

export const MCP_USAGE = `orca2 mcp                 list the servers in ~/.orca2/mcp.json (creates the file if missing)
  orca2 mcp test [name]     connect and count each server's tools
  orca2 mcp login <name>    sign in to a url server in the browser
  orca2 mcp logout <name>   forget that sign-in`;

const given = (value: string | null | undefined): value is string => typeof value === "string" && value !== "";

async function describe(entry: Entry): Promise<string> {
  const server = typeof entry.server === "object" && entry.server !== null ? entry.server : null;
  const how = server === null ? "" : given(server.command) ? [server.command, ...server.args].join(" ") : server.url ?? "";
  const signed = server !== null && given(server.url) && await signedIn(server);
  const state = entry.disabled ? "disabled" : given(entry.problem) ? `not usable: ${entry.problem}` : signed ? "ready, signed in" : "ready";
  return `  ${entry.name.padEnd(16)} ${state}${how !== "" ? `\n  ${"".padEnd(16)} ${how}` : ""}`;
}

async function test(name: string): Promise<string> {
  try {
    const tools = await withServer(name, process.cwd(), undefined, async (client, options) => (await client.listTools({}, options)).tools);
    return `  ${name.padEnd(16)} connected, ${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length > 0 ? `: ${tools.slice(0, 8).map(t => t.name).join(", ")}${tools.length > 8 ? ", …" : ""}` : ""}`;
  } catch (error) { return `  ${name.padEnd(16)} failed: ${error instanceof Error ? error.message : String(error)}`; }
}

export async function runMcp(args: string[], out: (line: string) => void = console.log): Promise<void> {
  const [action = "list", name] = args;
  try {
    const { path, entries, problem } = readServers();
    if (action === "list") {
      if (!existsSync(path)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, EXAMPLE, { flag: "wx" }); }
      out(`MCP servers in ${path}`);
      if (given(problem)) throw new Error(problem);
      for (const entry of entries) out(await describe(entry));
      if (entries.length === 0) out(`  none yet. Add one inside "mcpServers", for example:\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }`);
    } else if (action === "test") {
      if (given(problem)) throw new Error(problem);
      const names = given(name) ? [name] : entries.filter(e => !e.disabled).map(e => e.name);
      if (names.length === 0) out("  nothing to test: no enabled servers");
      for (const each of names) out(await test(each));
    } else if (action === "login" && given(name)) {
      await loginServer(usableServer(name), url => out(`Open this address to sign in to ${name}:\n${url}`));
      out(`${name}: signed in`);
    } else if (action === "logout" && given(name)) {
      await disconnectServers(name); await logoutServer(usableServer(name)); out(`${name}: signed out`);
    } else throw new Error(`usage:\n  ${MCP_USAGE}`);
  } finally { await disconnectServers(); }
}
