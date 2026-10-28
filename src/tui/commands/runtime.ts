import { BUILD_ID } from "../../config";
import { runtimeContexts, usageSummary } from "../../core/data/knowledge";
import { listProcesses, liveProcess } from "../../core/data/processes";
import { liveStatus } from "../../core/agent-loop/orc";

export async function runtimeText(project: string): Promise<string> {
  const [agents, processes, daemon] = await Promise.all([runtimeContexts(project), listProcesses(project), liveStatus(project)]);
  return [`This UI loaded: ${BUILD_ID}`, `Daemon loaded: ${daemon?.build ?? "unknown (restart to record build)"}`,
    ...agents.map(a => `${a.agent}: loaded ${a.build}; ${a.model}; ~${a.contextTokens} context tokens; observed ${a.updatedAt}`),
    ...processes.filter(p => liveProcess(p) || p.state === "unknown").map(p => `${p.owner}: ${p.state} command ${p.id}${p.readyAt ? `; preview observed ready ${p.readyUrl} at ${p.readyAt}` : ""}`),
    "Loaded identities are observations, not proof that source changes were installed. Older observations are not liveness checks."].join("\n");
}
export async function usageText(project: string): Promise<string> {
  const t = await usageSummary(project);
  return `${t.requests} requests; ${t.failed} failed; ${t.input} input tokens (${t.cachedInput} cached); ${t.output} output tokens; ${Math.round(t.durationMs / 1000)}s summed request time; ${t.usageMissing} requests without usage; ${t.retries} retries; ${t.toolCalls} tool calls; ${t.processRuns} completed processes; ~${t.peakContext} peak context tokens. Overlapping durations are not wall time; token usage is not a subscription invoice.`;
}
