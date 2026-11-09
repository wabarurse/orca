import type { AgentInfo } from "../../protocol";

export function runningAgentCount(rows: AgentInfo[]): number {
  return new Set(rows.filter(row => /^(worker|reviewer)(-|$)/.test(row.name) &&
    row.live && row.status !== "unknown").map(row => row.name)).size;
}
