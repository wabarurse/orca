// The records every part of orca2 shares: roles, inbox messages, transcript entries and tool calls.
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type Role = "orchestrator" | "worker" | "reviewer";

/** How queued user input joins a running agent: `steer` after the current reply (between tool batches),
 * `follow` only once the agent has finished its work. */
export type Delivery = "steer" | "follow";

/** One inbox message. `id` is the file's identity, echoed in the transcript entry that consumed it. */
export type Message = {
  id: string;
  from: string;
  text: string;
  ts: string;
  /** Pasted image ids (conversation image store). */
  images: string[];
  delivery: Delivery;
};

export type Entry =
  | { type: "message"; uuid: string; parent: string | null; ts: string; message: MessageParam; inbox: Message[] }
  /** A context checkpoint: the summary text replaces everything before it; `retained` is the verbatim tail. */
  | { type: "summary"; uuid: string; parent: string | null; ts: string; text: string; retained: MessageParam[]; memory: RollingMemory | null }
  | { type: "meta"; uuid: string; parent: string | null; ts: string; role: Role; agent: string; model: string; plugins: string[] }
  /** What a turn sent the user, so a reopened page shows it where it showed live. Never sent to the model. */
  | { type: "replies"; uuid: string; parent: string | null; ts: string; messages: { from: string; text: string }[] };

export type NewEntry = Entry extends infer E ? E extends Entry ? Omit<E, "uuid" | "parent" | "ts"> : never : never;

export type RollingMemory = { summary: string[]; pending: string[] };

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolOutcome = { id: string; ok: boolean; text: string };

/** Everything an agent run reports, in order: what `orca2 -p --json` prints and what the live file carries. */
export type AgentEvent =
  | { kind: "start"; agent: string; role: Role; model: string }
  | { kind: "input"; messages: Message[] }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; call: ToolCall }
  | { kind: "tool_end"; call: ToolCall; outcome: ToolOutcome }
  | { kind: "notice"; text: string }
  | { kind: "usage"; model: string; input: number; cached: number; output: number }
  | { kind: "compaction"; before: number; after: number }
  | { kind: "end"; status: "done" | "cancelled" | "failed"; error: string | null; text: string };
