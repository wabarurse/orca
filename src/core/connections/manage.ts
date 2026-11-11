import { paths } from "../../config";
import { checkedConnection, listConnections, removeConnection, saveConnection } from "./config";
import { disconnectConnections, withConnection } from "./client";
import { loginConnection, logoutConnection } from "./auth";

export async function manageConnections(command: string, project?: string, show: (url: string) => void = console.log): Promise<string> {
  const [action = "list", name, ...rest] = command.trim().split(/\s+/);
  if (!command.trim() || action === "list") return JSON.stringify(listConnections(project), null, 2);
  if (action === "save") {
    if (!["global", "project"].includes(name ?? "")) throw new Error("use save global|project followed by connection JSON");
    if (name === "project" && !project) throw new Error("project scope needs an open conversation");
    const connection = checkedConnection(JSON.parse(command.match(/^\s*save\s+(?:global|project)\s+([\s\S]+)$/)![1]!));
    saveConnection(connection, name === "project" ? project : undefined);
    await disconnectConnections(connection.name);
    return `Saved ${connection.name}. Connections start only when tested or used.`;
  }
  const connection = listConnections(project).find(c => c.name === name);
  if (!connection) throw new Error(`unknown connection: ${name ?? ""}`);
  const scope = connection.scope === "connections:global" ? undefined : project;
  if (["remove", "enable", "disable", "logout"].includes(action)) {
    await disconnectConnections(connection.name);
    if (action === "remove") { removeConnection(connection.name, scope); await logoutConnection(connection); }
    else if (action === "logout") await logoutConnection(connection);
    else saveConnection({ ...connection, enabled: action === "enable" }, scope);
    return `${connection.name}: ${action}`;
  }
  if (action === "login") { await disconnectConnections(connection.name); await loginConnection(connection, show); return `${connection.name}: signed in`; }
  if (action === "test" || action === "tools") {
    return withConnection(project, connection.name, project ? paths.repo(project) : process.cwd(), undefined, async (client, options) => {
      const capabilities = client.getServerCapabilities();
      if (action === "test") return `${connection.name}: connected; capabilities ${Object.keys(capabilities ?? {}).join(", ") || "none"}`;
      const tools = await client.listTools({}, options);
      return JSON.stringify({ tools: tools.tools.map(t => ({ name: t.name, description: t.description })), nextCursor: tools.nextCursor }, null, 2);
    });
  }
  throw new Error("connections: list | save global|project JSON | test|tools|login|logout|enable|disable|remove NAME");
}
