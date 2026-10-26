// What crosses between a project's orchestrator daemon and its TUI clients
// (core/agent-loop/orc/channel.ts carries it over files, orc/live.ts streams the
// running turn): the daemon's published status, the request/ack messages and the
// live-file events.

import type { ContextWindow } from "../providers/catalog";
import type { ToolCall, ToolOutcome } from "./toolview";

export type DaemonState = "idle" | "turn" | "stopped";
export interface DaemonStatus {
  pid: number;
  run: string;
  state: DaemonState;
  /** When `state` began (ISO). */
  since: string;
  /** Turns started by this daemon, so a client can tell a turn began and ended between two reads. */
  turns: number;
  /** The last turn's context estimate for the header; absent until a turn ran. */
  context?: { model: string; used?: number; window: ContextWindow };
  /** The last turn's failure, until the next turn. */
  error?: string;
}
export type Command = { kind: "clear" } | { kind: "compact" } | { kind: "model"; model: string } | { kind: "stop" };
export interface Request { id: string; ts: string; command: Command }
export interface Ack { id: string; ok: boolean; message: string; at: string }

/** What happened during the turn, after the transcript entry `head` (the daemon's head when it happened). */
export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "status"; text: string }
  | { kind: "tool_start"; call: ToolCall }
  | { kind: "tool_end"; outcome: ToolOutcome }
  | { kind: "truncated" };
export type LiveEvent =
  | { seq: 0; kind: "start"; run: string; turn: number; at: string }
  | (TurnEvent & { seq: number; head: string | null });
/** Which turn a live file belongs to: the daemon's run and its status.json turn counter. */
export interface LiveKey { run: string; turn: number }
