import { BUILD_ID } from "../../config";
import { runtimeContexts, usageSummary } from "../data/knowledge";
import { listProcesses, processOwner } from "../data/processes";
import { agentActivity } from "../tmux";
import { allTasks } from "../data/tasks";
import { bubbleMembers, peekBubble } from "../data/bubbles";
import { publicTaskStatus } from "../../protocol/task";
import type { Tool } from "./registry";
import { peerConversations } from "./peer-messages";

/** The tasks still in play (not merged, closed or removed), one short row each: what a status question is about. */
async function openTasks(project: string) {
  return (await allTasks(project)).filter(t => !t.removedAt).map(t => ({ number: t.number ?? null, title: t.name, status: publicTaskStatus(t), branch: t.branch, pr: t.pr?.number ?? null }))
    .filter(t => t.status !== "merged" && t.status !== "closed");
}
/** The open tasks of the other orchestrators in this bubble, by owner: visible to all of them, changed only by the owner (its notices go to its inbox). */
async function bubbleTasks(project: string) {
  const bubble = peekBubble(project);
  const others = bubble ? bubbleMembers(bubble).filter(member => member !== project) : [];
  return Promise.all(others.map(async owner => ({ owner, tasks: await openTasks(owner).catch(() => null) })));
}

export const runtime: Tool = {
  parallel: () => true,
  spec: { name: "runtime", description: "Read-only current-project status: open tasks (number, title, status, branch, PR; answer a status question from these, task get for detail; bubbleTasks are other orchestrators' open tasks in your bubble, owned by them), agents and queued follow-ups, tracked commands, historical context observations, usage, or sibling orchestrators. action conversations lists current/sibling conversation IDs, names, message addresses and queue/stop observations in the same checkout; these do not prove liveness. Use inbox send to coordinate only relevant authorized work. Running requires matching launch/run, live PID and live tmux pane. Null count/unknown means unverified, not idle. Queued messages do not start agents. Does not inspect application cron, external schedulers or production toggles. all_projects applies only to usage. Never launches or resumes work.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["status", "usage", "conversations"] }, all_projects: { type: "boolean" } }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "conversations") return peerConversations(ctx);
    if (input.action === "usage") return JSON.stringify(await usageSummary(input.all_projects === true ? undefined : ctx.project));
    if (input.action !== "status") throw new Error("unknown runtime action");
    const [activity, contextObservations, processes, tasks] = await Promise.all([agentActivity(ctx.project), runtimeContexts(ctx.project).catch(() => null), listProcesses(ctx.project).catch(() => null), openTasks(ctx.project).catch(() => null)]);
    const bubble = await bubbleTasks(ctx.project).catch(() => []);
    return JSON.stringify({ loadedBuild: BUILD_ID, project: ctx.project, tasks, ...(bubble.length ? { bubbleTasks: bubble } : {}), ...activity,
      agents: activity.agents.map(({ record: _record, ...agent }) => agent), contextObservations,
      errors: [...activity.errors, ...(contextObservations === null ? ["historical context observations unavailable"] : []), ...(processes === null ? ["recorded process observations unavailable"] : []), ...(tasks === null ? ["tasks unavailable"] : [])],
      applicationSchedules: "not_inspected", processVerification: "recorded_states_only",
      processes: processes?.map(p => ({ id: p.id, owner: processOwner(p), kind: p.prWatch ? "pr_watch" : "command", state: p.state, settledAt: p.settledAt, readyUrl: p.readyAt ? p.readyUrl : undefined, observedAt: p.updatedAt })) ?? null });
  },
};
