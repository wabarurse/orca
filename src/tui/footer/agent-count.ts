import type { AgentInfo } from "../../protocol";

export interface AgentCounts {
  agentCount?: number | null;
  verifiedAgentCount?: number;
  waitingAgentCount?: number;
  unverifiedAgentCount?: number | null;
}
export function agentCounts(rows: AgentInfo[]): AgentCounts {
  const workers = rows.filter(row => /^(worker|reviewer)(-|$)/.test(row.name));
  const verifiedAgentCount = new Set(workers.filter(row => row.live && row.status !== "unknown").map(row => row.name)).size;
  const unverifiedAgentCount = rows.some(row => row.inventoryComplete === false) ? null
    : new Set(workers.filter(row => row.status === "unknown").map(row => row.name)).size;
  const waitingAgentCount = new Set(workers.filter(row => row.live && row.status !== "unknown" && row.waitingForCommands).map(row => row.name)).size;
  return { verifiedAgentCount, unverifiedAgentCount, waitingAgentCount,
    agentCount: unverifiedAgentCount === 0 ? verifiedAgentCount : null };
}
export function agentCountText(counts: AgentCounts): string {
  if (counts.agentCount === null && counts.verifiedAgentCount === undefined) return "agent status unavailable";
  const n = counts.agentCount ?? counts.verifiedAgentCount ?? 0, noun = n === 1 ? "agent" : "agents";
  const waiting = counts.waitingAgentCount ? ` · ${counts.waitingAgentCount} waiting on commands` : "";
  if (counts.agentCount !== null) return `${n} ${noun} running${waiting}`;
  return counts.unverifiedAgentCount == null ? `${n} confirmed ${noun} running (inventory incomplete)${waiting}`
    : `${n} confirmed ${noun} running (${counts.unverifiedAgentCount} unverified)${waiting}`;
}
