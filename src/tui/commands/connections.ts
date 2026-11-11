import { listConnections, manageConnections, type ConfiguredConnection } from "../../core/connections";
import type { Choice } from "./model";
export interface ConnectionsHost {
  project?: string;
  current(): boolean;
  note(text: string): void;
  draft(text: string): void;
  open<T>(title: string, choices: Choice<T>[], pick: (value: T) => void | Promise<void>): void;
}
export async function connectionsCommand(args: string, host: ConnectionsHost): Promise<void> {
  if (args.trim()) { const text = await manageConnections(args, host.project, url => host.note(`Sign in: ${url}`)); if (host.current()) host.note(text); return; }
  const rows = listConnections(host.project);
  host.open("Connections · select to manage", [
    ...rows.map(c => ({ label: `${c.name} · ${c.transport} · ${c.enabled ? "enabled" : "disabled"} · ${c.scope === "connections:global" ? "global" : "project"}`, value: c })),
    { label: "Add connection", value: null },
  ] as Choice<ConfiguredConnection | null>[], async c => {
    if (!host.current()) return;
    if (!c) {
      host.open("New connection", [{ label: "Remote HTTP server", value: "http" }, { label: "Local process server", value: "stdio" }], transport => {
        if (host.current()) host.draft(`/connections save ${host.project ? "project" : "global"} ${JSON.stringify(transport === "http" ? { name: "example", transport, enabled: true, url: "https://example.com/mcp", oauth: true } : { name: "example", transport, enabled: true, command: "bun", args: ["/path/to/server.ts"], env: [] })}`);
      }); return;
    }
    host.open(`${c.name} · ${c.url ?? c.command}`, ["test", "tools", "edit", c.enabled ? "disable" : "enable", ...(c.oauth ? ["login", "logout"] : []), "remove"].map(action => ({ label: action, value: action })), async action => {
      if (!host.current()) return;
      if (action === "edit") { const { scope, ...definition } = c; host.draft(`/connections save ${scope === "connections:global" ? "global" : "project"} ${JSON.stringify(definition)}`); return; }
      const text = await manageConnections(`${action} ${c.name}`, host.project, url => host.note(`Sign in: ${url}`));
      if (host.current()) host.note(text);
    });
  });
}
