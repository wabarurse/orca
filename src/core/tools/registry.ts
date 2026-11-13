// What a tool is and which tools each role gets. The implementations are
// mounted in mount.ts; every tool file imports its types from here.

import type { ImageBlockParam, TextBlockParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../../api";
import type { RequestSettings } from "../../api/catalog";
import type { Role, ImageRef } from "../../protocol";

export interface ToolContext {
  /** Trusted TUI handoff only; never populated from model tool arguments. */
  userFeedback?: { inputId: string; attachments: ImageRef[] };
  /** Execution generation that admitted this run; a resumed conversation cannot revive it. */
  executionEpoch?: string;
  callId?: string;
  signal?: AbortSignal;
  /** Exact supervised run; not a branch-derived task identity. */
  run?: string;
  /** Snapshot that produced this tool call; never re-resolve mid-batch. */
  selected?: { model: string; provider: Provider; settings?: RequestSettings };
  project: string;
  role: Role;
  branch?: string;
  cwd: string;
}

/** What a tool returns: text, or text with scoped image blocks (`read` of an
 * image; references into the project image store, never bytes). */
export type ToolResult = string | (TextBlockParam | ImageBlockParam)[];

/** `R` narrows the result; most tools return text. Collections of tools are `Tool<ToolResult>`. */
export interface Tool<R extends ToolResult = string> {
  spec: ApiTool;
  /** Explicit independence contract; omitted tools are ordering barriers. */
  parallel?: (input: Record<string, unknown>) => boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<R>;
}

// Which tools each role gets. The set is deliberately small. `history` is orchestrator-only by owner decision.
export const toolsFor: Record<Role, string[]> = {
  orchestrator: ["bash", "read", "write", "edit", "process", "sandbox", "context", "remember", "skill", "runtime", "spawn", "inbox", "web_search", "task", "history", "memory", "mcp"],
  worker: ["bash", "read", "write", "edit", "process", "sandbox", "skill", "inbox", "web_search", "task", "mcp"],
  reviewer: ["bash", "read", "write", "edit", "process", "sandbox", "skill", "inbox", "web_search", "task", "mcp"],
};
