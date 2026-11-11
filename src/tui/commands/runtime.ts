import { formatDateTime } from "../../protocol";
import { BUILD_ID } from "../../config";
import { runtimeContexts, usageSummary } from "../../core/data/knowledge";
import { processOwner, listProcesses, unresolvedProcess } from "../../core/data/processes";
import { liveStatus } from "../../core/agent-loop/orc";
import { agentActivity } from "../../core/tmux";

export async function runtimeText(project: string): Promise<string> {
  const [agents, processes, daemon, activity] = await Promise.all([runtimeContexts(project), listProcesses(project), liveStatus(project), agentActivity(project)]);
  return [`This UI loaded: ${BUILD_ID}`, `Daemon loaded: ${daemon?.build ?? "unknown (restart to record build)"}`,
    `Agents running: ${activity.runningCount ?? "unknown"} (verified ${activity.verifiedRunningCount}); observed ${formatDateTime(activity.observedAt)}`,
    ...activity.agents.map(a => `${a.agent}: ${a.status}; ${a.queuedMessages ?? "unknown"} queued${a.task ? `; task #${a.task.number ?? a.task.id} ${a.task.name}` : ""}; ${a.reason}`),
    "Historical context observations (not activity):",
    ...agents.map(a => `${a.agent}: loaded ${a.build}; ${a.model}; ~${a.contextTokens} context tokens; observed ${formatDateTime(a.updatedAt)}`),
    ...processes.filter(p => unresolvedProcess(p)).map(p => `${processOwner(p)}: recorded ${p.state} command ${p.id}${p.readyAt ? `; preview observed ready ${p.readyUrl} at ${formatDateTime(p.readyAt)}` : ""}`),
    ...activity.errors, "Application cron/schedules and production toggles were not inspected. Queued messages do not start agents.",
    "Loaded identities are observations, not proof that source changes were installed. Older observations are not liveness checks."].join("\n");
}
export async function usageText(project: string): Promise<string> {
  const t = await usageSummary(project);
  return `${t.requests} requests; ${t.failed} failed; ${t.input} input tokens (${t.cachedInput} cached); ${t.output} output tokens; ${Math.round(t.durationMs / 1000)}s summed request time; ${t.usageMissing} requests without usage; ${t.retries} retries; ${t.toolCalls} tool calls; ${t.processRuns} completed processes; ~${t.peakContext} peak context tokens. Overlapping durations are not wall time; token usage is not a subscription invoice.`;
}
