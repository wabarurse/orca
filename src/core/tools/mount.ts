// The mounted tools, by name; registry.ts says what a tool is and which each role gets, index.ts is the folder's barrel.

import { web_search } from "./web-search";
import { ask } from "./ask";
import { bash } from "./bash";
import { complexity } from "./complexity";
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
import type { Tool } from "./registry";

export const registry: Record<string, Tool> = { bash, read, write, edit, process: processTool, remember: rememberTool, context: contextTool, skill, runtime, spawn, message, ask, complexity, web_search, task, history, memory };
