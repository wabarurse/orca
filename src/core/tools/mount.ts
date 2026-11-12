// The mounted tools, by name; registry.ts says what a tool is and which each role gets, index.ts is the folder's barrel.

import { web_search } from "./web-search";
import { inbox } from "./inbox";
import { bash } from "./bash";
import { history, memory } from "./history";
import { task } from "./task";
import { spawn } from "./spawn";
import { read, write, edit } from "./files";
import { sandbox } from "./sandbox";
import { processTool } from "./process";
import { rememberTool } from "./remember";
import { contextTool } from "./context";
import { skill } from "./skill";
import { runtime } from "./runtime";
import type { Tool, ToolResult } from "./registry";
import { mcp } from "./mcp";

export const registry: Record<string, Tool<ToolResult>> = { mcp, sandbox, bash, read, write, edit, process: processTool, remember: rememberTool, context: contextTool, skill, runtime, spawn, inbox, web_search, task, history, memory };
