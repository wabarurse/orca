import { bash } from "./bash";
import { behaviorTool } from "./behavior";
import { edit } from "./edit";
import { read } from "./read";
import { write } from "./write";
import { inbox } from "./inbox";
import { mcp } from "./mcp";
import { memory } from "./memory";
import { notebook } from "./notebook";
import type { Tool } from "./registry";
import { skill } from "./skill";
import { subagent } from "./subagent";
import { web_search } from "./web-search";

export const coreTools: Record<string, Tool> = { bash, read, write, edit, subagent, inbox, memory, notebook, behavior: behaviorTool, skill, web_search, mcp };
