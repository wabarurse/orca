import { disconnectConnections, manageConnections } from "../core/connections";
export async function runConnections(args: string[]): Promise<void> {
  const at = args.indexOf("--project");
  const project = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !project) throw new Error("--project requires a conversation ID");
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  try { console.log(await manageConnections(rest.join(" "), project)); }
  finally { await disconnectConnections(); }
}
