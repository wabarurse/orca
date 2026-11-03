import { BUILD_ID } from "../../config";
import { runtimeContexts, usageSummary } from "../data/knowledge";
import { listProcesses } from "../data/processes";
import { agentActivity } from "../tmux";
import type { Tool } from "./registry";
import { peerConversations } from "./peer-messages";

export const runtime: Tool = {
  parallel: () => true,
  spec: { name: "runtime", description: "Read-only current-project agent status and queued follow-ups, tracked commands, historical context observations, usage, or sibling orchestrators. action conversations lists current/sibling conversation IDs, names, message addresses and queue/stop observations in the same checkout; these do not prove liveness. Use message to coordinate only relevant authorized work. Running requires matching launch/run, live PID and live tmux pane. Null count/unknown means unverified, not idle. Queued messages do not start agents. Does not inspect application cron, external schedulers or production toggles. all_projects applies only to usage. Never launches or resumes work.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["status", "usage", "conversations"] }, all_projects: { type: "boolean" } }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "conversations") return peerConversations(ctx);
    if (input.action === "usage") return JSON.stringify(await usageSummary(input.all_projects === true ? undefined : ctx.project));
    if (input.action !== "status") throw new Error("unknown runtime action");
    const [activity, contextObservations, processes] = await Promise.all([agentActivity(ctx.project), runtimeContexts(ctx.project).catch(() => null), listProcesses(ctx.project).catch(() => null)]);
    return JSON.stringify({ loadedBuild: BUILD_ID, project: ctx.project, ...activity,
      agents: activity.agents.map(({ record: _record, ...agent }) => agent), contextObservations,
      errors: [...activity.errors, ...(contextObservations === null ? ["historical context observations unavailable"] : []), ...(processes === null ? ["recorded process observations unavailable"] : [])],
      applicationSchedules: "not_inspected", processVerification: "recorded_states_only",
      processes: processes?.map(p => ({ id: p.id, owner: p.owner, state: p.state, readyUrl: p.readyAt ? p.readyUrl : undefined, observedAt: p.updatedAt })) ?? null });
  },
};
