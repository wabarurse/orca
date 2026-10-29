// The /agents row record (core/tmux/liveness.ts fills it from tmux and the run records).

/** One /agents row: the agent, whether its window is live, its latest run's times and what keeps it listed. */
export interface AgentInfo {
  name: string;
  live: boolean;
  activity?: string;
  /** ISO start of the latest run. */
  startedAt?: string;
  /** ISO end of that run; absent while it is live. */
  endedAt?: string;
  /** endedAt is the run state's last update, not a recorded end (the agent was killed hard). */
  approximateEnd?: boolean;
  /** ISO time of the agent's latest known activity: its run's end, else its transcript's last write. */
  lastActiveAt?: string;
  /** Its latest task is not merged, removed, closed or cancelled yet, so /agents keeps showing it however old. */
  openTask?: boolean;
  /** The user removed this finished agent's row (d/D in /agents); it shows again once the agent is started again. */
  archived?: boolean;
}
