import type { ImageBlockParam, TextBlockParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../../api";
import type { RequestSettings } from "../../api/model";
import type { Role } from "../types";
import { type Result } from "../../config";

export type AgentInfo = {
  agent: string;
  role: Role;
  bundle: string;
  branch: string;
  state: "starting" | "running" | "reported" | "exited" | "failed" | "stopped";
  pid: number | null;
  runner: string;
  startedAt: string;
  endedAt: string | null;
  log: string;
  lastTool: string | null;
};

export type SpawnRequest = { bundle: string; branch: string; brief: string; fresh: boolean; images: string[] };

export type Runtime = {
  spawn: (request: SpawnRequest) => Promise<AgentInfo>;
  agents: () => Promise<AgentInfo[]>;
  stop: (agent: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
};

export type ToolContext = {
  conversation: string;
  agent: string;
  role: Role;
  branch: string | null;
  cwd: string;
  data: string;
  trusted: boolean;
  pluginSkills: string[];
  callId: string;
  signal: AbortSignal;
  model: string;
  provider: Provider;
  settings: RequestSettings | null;
  runtime: Runtime;
};

export type ToolResult = string | (TextBlockParam | ImageBlockParam)[];

export type Tool = {
  spec: ApiTool;
  parallel: (input: Record<string, unknown>) => boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export const CORE_TOOLS: Record<Role, string[]> = {
  orchestrator: ["bash", "read", "subagent", "inbox", "memory", "notebook", "behavior", "skill", "web_search", "mcp"],
  worker: ["bash", "read", "write", "edit", "inbox", "memory", "notebook", "skill", "web_search", "mcp"],
  reviewer: ["bash", "read", "write", "edit", "inbox", "memory", "notebook", "skill", "web_search", "mcp"],
};

export const CORE_TOOL_NAMES = ["bash", "read", "write", "edit", "subagent", "inbox", "memory", "notebook", "behavior", "skill", "web_search", "mcp"];

export function settled<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
