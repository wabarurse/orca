// `orca mcp`: look at the servers in ~/.orca/mcp.json, try them, and sign in to one. Adding,
// editing and removing a server is editing that file; there is nothing here that writes it
// except creating an empty one to open.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { disconnectServers, EXAMPLE, loginServer, logoutServer, readServers, signedIn, usableServer, withServer, type Entry } from "../../core/mcp";

export const MCP_USAGE = `orca mcp                 list the servers in ~/.orca/mcp.json (creates the file if missing)
  orca mcp test [name]     connect and count each server's tools
  orca mcp login <name>    sign in to a url server in the browser
  orca mcp logout <name>   forget that sign-in`;

async function describe(entry: Entry): Promise<string> {
  const how = entry.server ? entry.server.command !== undefined ? [entry.server.command, ...entry.server.args].join(" ") : entry.server.url! : "";
  const state = entry.disabled ? "disabled" : entry.problem ? `not usable: ${entry.problem}` : entry.server?.url && await signedIn(entry.server) ? "ready, signed in" : "ready";
  return `  ${entry.name.padEnd(16)} ${state}${how ? `\n  ${"".padEnd(16)} ${how}` : ""}`;
}

async function test(name: string): Promise<string> {
  try {
    const tools = await withServer(name, process.cwd(), undefined, async (client, options) => (await client.listTools({}, options)).tools);
    return `  ${name.padEnd(16)} connected, ${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length ? `: ${tools.slice(0, 8).map(t => t.name).join(", ")}${tools.length > 8 ? ", …" : ""}` : ""}`;
  } catch (error) { return `  ${name.padEnd(16)} failed: ${error instanceof Error ? error.message : error}`; }
}

export async function runMcp(args: string[], out: (line: string) => void = console.log): Promise<void> {
  const [action = "list", name] = args;
  try {
    const { path, entries, problem } = readServers();
    if (action === "list") {
      if (!existsSync(path)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, EXAMPLE, { flag: "wx" }); }
      out(`MCP servers in ${path}`);
      if (problem) throw new Error(problem);
      for (const entry of entries) out(await describe(entry));
      if (!entries.length) out(`  none yet. Add one inside "mcpServers", for example:\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }`);
    } else if (action === "test") {
      if (problem) throw new Error(problem);
      const names = name ? [name] : entries.filter(e => !e.disabled).map(e => e.name);
      if (!names.length) out("  nothing to test: no enabled servers");
      for (const each of names) out(await test(each));
    } else if (action === "login" && name) {
      await loginServer(usableServer(name), url => out(`Open this address to sign in to ${name}:\n${url}`));
      out(`${name}: signed in`);
    } else if (action === "logout" && name) {
      await disconnectServers(name); await logoutServer(usableServer(name)); out(`${name}: signed out`);
    } else throw new Error(`usage:\n  ${MCP_USAGE}`);
  } finally { await disconnectServers(); }
}
