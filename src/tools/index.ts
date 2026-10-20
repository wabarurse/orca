import type { Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Role } from "../transcript";

export interface ToolContext {
  project: string;
  role: Role;
  taskId?: string;
  cwd: string;
}

export interface Tool {
  spec: ApiTool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Which tools each role gets. The set is deliberately small.
export const toolsFor: Record<Role, string[]> = {
  orchestrator: ["bash", "spawn", "message"],
  worker: ["bash", "message"],
  reviewer: ["bash", "message"],
};

// TODO(PR3, PR5): register bash, spawn, message here.
export const registry: Record<string, Tool> = {};
