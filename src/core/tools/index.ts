// The mounted tools, by name; registry.ts says what a tool is and which each role gets.

import { web_search } from "./web-search";
import { ask } from "./ask";
import { bash } from "./bash/bash";
import { complexity } from "./complexity/complexity";
import { history } from "./history";
import { message } from "./message";
import { task } from "./task";
import { spawn } from "./spawn";
import type { Tool } from "./registry";

export const registry: Record<string, Tool> = { bash, spawn, message, ask, complexity, web_search, task, history };
