import { existsSync, realpathSync } from "node:fs";
import { paths, repositoryBinding } from "../../config";
import { assertProjectIdentity, displayName, listProjects, projectIdentity } from "../data/projects";
import { execution } from "../data/projects/lifecycle";
import { pendingCount } from "../data/inbox";
import type { ToolContext } from "./registry";

const address = (project: string) => `orchestrator@${project}`;
function directory(project: string): string {
  if (!existsSync(paths.project(project))) throw new Error("conversation is missing or deleted");
  const binding = repositoryBinding(project);
  if (!binding) throw new Error("conversation has no bound directory");
  return realpathSync(binding.directory);
}

/** Stable IDs disambiguate renamed/duplicate conversations; shared remotes do
 * not establish membership. Observe only: no folder refresh or daemon launch. */
export async function peerConversations(ctx: ToolContext): Promise<string> {
  if (ctx.role !== "orchestrator") throw new Error("only orchestrators can discover peer conversations");
  const source = directory(ctx.project), conversations = [];
  for (const id of await listProjects()) {
    let candidate: string;
    try { candidate = directory(id); } catch { continue; }
    if (candidate !== source) continue;
    conversations.push({ id, name: await displayName(id), address: address(id), current: id === ctx.project,
      stopped: stopped(id), queuedMessages: await pendingCount(id, "orchestrator").catch(() => null) });
  }
  return JSON.stringify({ directory: source, observedAt: new Date().toISOString(), conversations,
    delivery: "enqueue_only; existing active daemons may consume messages; stopped/exited conversations are not restarted" });
}

/** Called again under the receiver's publication lock, so a renamed/recreated
 * conversation or changed binding cannot silently redirect a pending message. */
export function peerTarget(to: string, ctx: ToolContext) {
  if (!to.includes("@")) return undefined;
  const match = /^orchestrator@([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(to);
  if (!match) throw new Error("invalid peer address; use runtime action conversations");
  if (ctx.role !== "orchestrator") throw new Error("only orchestrators can message peer conversations");
  const project = match[1]!;
  if (project === ctx.project) throw new Error("refused: that's your own inbox");
  const sourceDirectory = directory(ctx.project);
  if (directory(project) !== sourceDirectory) throw new Error("peer conversation must belong to the same checkout");
  const source = projectIdentity(ctx.project), target = projectIdentity(project);
  const check = () => {
    ctx.signal?.throwIfAborted();
    assertProjectIdentity(ctx.project, source, "sending a peer message");
    assertProjectIdentity(project, target, "sending a peer message");
    if (ctx.executionEpoch !== undefined) execution.assertActive(ctx.project, ctx.executionEpoch);
    if (directory(project) !== sourceDirectory || directory(ctx.project) !== sourceDirectory) throw new Error("peer conversation must belong to the same checkout");
  };
  return { project, from: address(ctx.project), check };
}
function stopped(project: string): boolean | null {
  try { return execution.stopped(project); } catch { return null; }
}
export function peerReceipt(to: string, project: string, inputId: string): string {
  return JSON.stringify({ to, inputId, enqueued: true, agentStarted: false, processingConfirmed: false,
    projectStopped: stopped(project), observedAt: new Date().toISOString(),
    nextAction: "Queued only. Finish your turn so the peer can acquire the checkout lock. Do not poll for a reply or restart stopped/exited conversations. A reply, not enqueue acceptance, confirms processing." });
}
