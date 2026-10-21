import type { Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Role } from "../transcript";
import { ask } from "./ask";
import { bash } from "./bash";
import { complexity } from "./complexity";
import { message } from "./message";
import { spawn } from "./spawn";

export interface ToolContext {
  project: string;
  role: Role;
  branch?: string;
  cwd: string;
}

export interface Tool {
  spec: ApiTool;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Which tools each role gets. The set is deliberately small.
export const toolsFor: Record<Role, string[]> = {
  orchestrator: ["bash", "spawn", "message", "ask"],
  worker: ["bash", "message"],
  reviewer: ["bash", "message", "complexity"],
};

export const registry: Record<string, Tool> = { bash, spawn, message, ask, complexity };
