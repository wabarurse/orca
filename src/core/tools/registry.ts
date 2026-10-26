// What a tool is and which tools each role gets. The implementations are
// mounted in index.ts; every tool file imports its types from here.

import type { Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../../providers";
import type { RequestSettings } from "../../providers/catalog";
import type { Role } from "../../protocol";

export interface ToolContext {
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

export interface Tool {
  spec: ApiTool;
  /** Explicit independence contract; omitted tools are ordering barriers. */
  parallel?: (input: Record<string, unknown>) => boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Which tools each role gets. The set is deliberately small. `history` is orchestrator-only by owner decision.
export const toolsFor: Record<Role, string[]> = {
  orchestrator: ["bash", "spawn", "message", "ask", "web_search", "task", "history"],
  worker: ["bash", "message", "web_search", "task"],
  reviewer: ["bash", "message", "complexity", "web_search", "task"],
};
