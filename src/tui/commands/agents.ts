import type { AgentInfo } from "../../protocol";

export const RECENT_AGENT_MS = 24 * 60 * 60 * 1000;

/**
 * Shown by default: a live agent, or a finished one that is not removed and either ran for a task that is still
 * open or was active in the last 24h. A finished agent with no known time stays shown (nothing says it is old).
 */
export function recentAgent(a: AgentInfo, now: number): boolean {
  if (a.live || a.status === "unknown" || a.queuedMessages) return true;
  if (a.archived) return false;
  if (a.openTask) return true;
  const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : NaN;
  return Number.isNaN(at) || now - at < RECENT_AGENT_MS;
}
