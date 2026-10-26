// The /agents row record (core/tmux/liveness.ts fills it from tmux and the run records).

/** One /agents row: the agent, whether its window is live, and its latest run's times. */
export interface AgentInfo {
  name: string;
  live: boolean;
  /** ISO start of the latest run. */
  startedAt?: string;
  /** ISO end of that run; absent while it is live. */
  endedAt?: string;
  /** endedAt is the run state's last update, not a recorded end (the agent was killed hard). */
  approximateEnd?: boolean;
}
