import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type Role = "orchestrator" | "worker" | "reviewer";

export type Delivery = "steer" | "follow";

export type Message = {
  id: string;
  from: string;
  text: string;
  ts: string;
  images: string[];
  delivery: Delivery;
};

export type Entry =
  | { type: "message"; uuid: string; parent: string | null; ts: string; message: MessageParam; inbox: Message[] }
  | { type: "summary"; uuid: string; parent: string | null; ts: string; text: string; retained: MessageParam[]; memory: RollingMemory | null }
  | { type: "meta"; uuid: string; parent: string | null; ts: string; role: Role; agent: string; model: string; plugins: string[] }
  | { type: "replies"; uuid: string; parent: string | null; ts: string; messages: { from: string; text: string }[] };

export type NewEntry = Entry extends infer E ? E extends Entry ? Omit<E, "uuid" | "parent" | "ts"> : never : never;

export type RollingMemory = { summary: string[]; pending: string[] };

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolOutcome = { id: string; ok: boolean; text: string };

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
