// The mounted tools, by name; registry.ts says what a tool is and which each role gets, index.ts is the folder's barrel.

import { web_search } from "./web-search";
import { ask } from "./ask";
import { bash } from "./bash";
import { history, memory } from "./history";
import { message } from "./message";
import { task } from "./task";
import { spawn } from "./spawn";
import { read, write, edit } from "./files";
import { processTool } from "./process";
import { rememberTool } from "./remember";
import { contextTool } from "./context";
import { skill } from "./skill";
import { runtime } from "./runtime";
import type { Tool, ToolResult } from "./registry";

export const registry: Record<string, Tool<ToolResult>> = { bash, read, write, edit, process: processTool, remember: rememberTool, context: contextTool, skill, runtime, spawn, message, ask, web_search, task, history, memory };
