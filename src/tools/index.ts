import type { Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../providers";
import type { RequestSettings } from "../project-settings";
import { web_search } from "./web-search";
import type { Role } from "../transcript";
import { ask } from "./ask";
import { bash } from "./bash";
import { complexity } from "./complexity";
import { message } from "./message";
import { task } from "./task";
import { spawn } from "./spawn";

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

// Which tools each role gets. The set is deliberately small.
export const toolsFor: Record<Role, string[]> = {
  orchestrator: ["bash", "spawn", "message", "ask", "web_search", "task"],
  worker: ["bash", "message", "web_search", "task"],
  reviewer: ["bash", "message", "complexity", "web_search", "task"],
};

export const registry: Record<string, Tool> = { bash, spawn, message, ask, complexity, web_search, task };
