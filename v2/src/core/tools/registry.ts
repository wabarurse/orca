// What a tool is, what it is given when it runs, and which core tools each role gets.
import type { ImageBlockParam, TextBlockParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../../api";
import type { RequestSettings } from "../../api/model";
import type { Role } from "../types";

/** A subagent as `subagent list` and the Agents tab show it. */
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

/** What the runtime offers tools beyond files and commands: starting and inspecting subagents, asking the user. */
export type Runtime = {
  spawn: (request: SpawnRequest) => Promise<AgentInfo>;
  agents: () => Promise<AgentInfo[]>;
  stop: (agent: string) => Promise<string>;
  /** Ask the user a yes/no question (a hook's "ask"); false when nobody can answer. */
  confirm: (question: string) => Promise<boolean>;
};

export type ToolContext = {
  conversation: string;
  /** This agent's id: "orchestrator", "worker-<branch>", "reviewer-<branch>" or a bundle's own prefix. */
  agent: string;
  role: Role;
  /** The worker's branch; null for the orchestrator. */
  branch: string | null;
  cwd: string;
  /** `$ORCA_DATA` for this conversation. */
  data: string;
  /** Whether the folder is trusted: its instructions and skills load (trust.ts). */
  trusted: boolean;
  /** Skill folders of the plugins this agent uses. */
  pluginSkills: string[];
  callId: string;
  signal: AbortSignal;
  model: string;
  provider: Provider;
  settings: RequestSettings | null;
  runtime: Runtime;
};

/** Text, or text with image blocks (references into the conversation's image store, never bytes). */
export type ToolResult = string | (TextBlockParam | ImageBlockParam)[];

export type Tool = {
  spec: ApiTool;
  /** True when this call may overlap others in its batch (read-only work); anything else runs in order. */
  parallel: (input: Record<string, unknown>) => boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

/** The core tools each role gets; plugins add their own (index.ts `tools`). The orchestrator keeps `read` only. */
export const CORE_TOOLS: Record<Role, string[]> = {
  orchestrator: ["bash", "read", "subagent", "inbox", "memory", "notebook", "behavior", "skill", "web_search", "mcp"],
  worker: ["bash", "read", "write", "edit", "inbox", "memory", "notebook", "skill", "web_search", "mcp"],
  reviewer: ["bash", "read", "write", "edit", "inbox", "memory", "notebook", "skill", "web_search", "mcp"],
};

/** Every core tool name, in a stable order (the prompt cache depends on it). */
export const CORE_TOOL_NAMES = ["bash", "read", "write", "edit", "subagent", "inbox", "memory", "notebook", "behavior", "skill", "web_search", "mcp"] as const;
