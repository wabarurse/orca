// The clock beside each agent in /agents: how long its latest run has gone
// (live, ticking) or went (finished, final).

import type { AgentInfo } from "../../protocol";
import { bold, dim } from "../components";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Seconds under an hour ("59s", "3m 12s"), then "1h 04m", then "2d 3h". */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (total < 3600) return `${m}m ${pad2(total % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad2(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Wide enough for the longest clock ("~99d 23h"), so a row keeps its width as it ticks. */
const CLOCK_WIDTH = 8;

/** The elapsed time to show for `a` at `now`, or null when there is nothing to measure. */
export function elapsedMs(a: Pick<AgentInfo, "live" | "startedAt" | "endedAt">, now: number): number | null {
  const start = a.startedAt ? Date.parse(a.startedAt) : NaN;
  if (Number.isNaN(start)) return null;
  const end = a.live ? now : a.endedAt ? Date.parse(a.endedAt) : NaN;
  return Number.isNaN(end) ? null : end - start;
}

/** The /agents row text for one agent: "name  live 3m 12s" (clock bold) or "name  finished 14m 02s" (dim). */
export function agentRow(a: AgentInfo, now: number): string {
  const ms = elapsedMs(a, now);
  if (ms === null) return `${a.name}  ${dim(a.live ? "live" : "finished")}`;
  const text = formatElapsed(ms);
  if (a.live) return `${a.name}  ${dim("live")} ${bold(text.padEnd(CLOCK_WIDTH))}`;
  return `${a.name}  ${dim(`finished ${(a.approximateEnd ? "~" : "") + text}`.padEnd(CLOCK_WIDTH + 9))}`;
}

/** Where the selection goes when the list changes: the same agent by name, else the same position (kept in range). */
export function reselect(index: number, before: { name: string }[], after: { name: string }[]): number {
  const name = before[index]?.name;
  const at = name === undefined ? -1 : after.findIndex((a) => a.name === name);
  return at >= 0 ? at : Math.max(0, Math.min(index, after.length - 1));
}
