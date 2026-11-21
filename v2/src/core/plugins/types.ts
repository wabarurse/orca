// The plugin contract. A plugin is a folder: index.ts (loaded by every process: tools, prompt, skills, storage,
// hooks, bundles), ui.ts (the TUI only: tabs, counts, commands, tool lines, folds) and background.ts (the daemon
// only: watchers, a memory section, a runner, cleanup). UI is data: a plugin returns rows and text, orca draws them.
import type { MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { MemorySection } from "../loop/rolling";
import type { AgentInfo, Tool, ToolResult } from "../tools/registry";
import type { Message, Role } from "../types";

export type StorageScope = "conversation" | "bubble" | "global";

/** What every hook and slot is told about where it runs. */
export type PluginContext = {
  plugin: string;
  conversation: string;
  agent: string;
  role: Role;
  /** The agent's branch; null for the orchestrator and the TUI. */
  branch: string | null;
  cwd: string;
  /** This plugin's folder in a storage scope, created on first use. */
  data: (scope: StorageScope) => Promise<string>;
};

export type ToolCallInfo = { name: string; input: Record<string, unknown> };

export type BeforeToolResult =
  | { action: "run"; input: Record<string, unknown> }
  | { action: "block"; reason: string }
  | { action: "ask"; question: string };
export type BeforeTool = (call: ToolCallInfo, ctx: PluginContext) => Promise<BeforeToolResult>;
export type AfterTool = (call: ToolCallInfo, result: { ok: boolean; content: ToolResult }, ctx: PluginContext) => Promise<{ ok: boolean; content: ToolResult }>;
export type RequestShape = { system: string; messages: MessageParam[]; tools: ApiTool[] };
export type BeforeRequest = (request: RequestShape, ctx: PluginContext) => Promise<RequestShape>;
export type OnInput = (message: Message, ctx: PluginContext) => Promise<{ action: "keep"; text: string } | { action: "drop"; reason: string }>;

export type PluginHooks = { beforeTool: BeforeTool[]; afterTool: AfterTool[]; beforeRequest: BeforeRequest[]; onInput: OnInput[] };

/** `replaces` must be true to take the place of a core tool of the same name. */
export type PluginTool = { tool: Tool; roles: Role[]; replaces: boolean };

/** An agent preset: a role, its prompt and the plugins it uses ("*" for every enabled plugin). */
export type Bundle = { name: string; role: Role; prompt: string; plugins: string[] };

export type Plugin = {
  name: string;
  description: string;
  tools: PluginTool[];
  /** Added to an agent's system prompt only when its bundle uses this plugin. */
  prompt: { role: Role; text: string }[];
  /** Skill folders (holding SKILL.md), relative to the plugin folder. */
  skills: string[];
  storage: { scope: StorageScope; about: string }[];
  hooks: PluginHooks;
  bundles: Bundle[];
  /** "./ui.ts" or null. */
  ui: string | null;
  /** "./background.ts" or null. */
  background: string | null;
};

export const noHooks = (): PluginHooks => ({ beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] });

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

// ---- ui.ts ----

export type Tone = "normal" | "good" | "warn" | "bad" | "dim";
export type Row = { id: string; name: string; status: string; info: string; tone: Tone };
export type Section = { title: string; lines: string[] };

/** What a tab action or command can do on screen. */
export type UiHost = PluginContext & {
  note: (text: string) => void;
  confirm: (question: string) => Promise<boolean>;
  input: (prompt: string, initial: string) => Promise<string | null>;
  pick: (title: string, options: string[]) => Promise<number | null>;
  /** Send text to the conversation's orchestrator as the user (queued as steer input, read after its current tool batch). */
  say: (text: string) => Promise<void>;
  /** Open a file in the desktop viewer (macOS `open`, `xdg-open` elsewhere). */
  open: (path: string) => Promise<void>;
};

export type TabAction = { key: string; label: string; run: (row: Row | null, host: UiHost) => Promise<void> };
export type Tab = {
  id: string;
  title: string;
  /** A Ctrl chord that opens the tab ("q" for Ctrl+Q), or null. */
  chord: string | null;
  rows: (ctx: PluginContext) => Promise<Row[]>;
  details: (row: Row, ctx: PluginContext) => Promise<Section[]>;
  actions: TabAction[];
};
export type Count = { id: string; count: (ctx: PluginContext) => Promise<number | null>; label: (n: number) => string };
export type Command = { name: string; description: string; run: (args: string, host: UiHost) => Promise<void> };
export type ToolLine = { label: (input: Record<string, unknown>) => string; summary: (outcome: { ok: boolean; text: string }) => { summary: string; failed: boolean } };
/** A finished call of the tool joins a "+ N <title>" fold of one-line items; `opens` names the tab each item opens. */
export type Fold = { title: (n: number) => string; items: (input: Record<string, unknown>, outcome: { ok: boolean; text: string }) => string[]; opens: string | null };

export type PluginUi = { tabs: Tab[]; counts: Count[]; commands: Command[]; toolLines: Record<string, ToolLine>; folds: Record<string, Fold> };

export function defineUi(ui: PluginUi): PluginUi {
  return ui;
}

// ---- background.ts ----

export type BackgroundContext = Omit<PluginContext, "agent" | "role" | "cwd" | "branch"> & {
  directory: string;
  /** Send a notice to the orchestrator's inbox, from this plugin (it wakes the orchestrator). */
  notify: (text: string) => Promise<void>;
  /** Send a notice to one agent's inbox; when that agent is not running it goes to the orchestrator instead. */
  tell: (agent: string, text: string) => Promise<void>;
  /** The conversation's agents and their states. */
  agents: () => Promise<AgentInfo[]>;
};
export type Watcher = { name: string; everyMs: number; run: (ctx: BackgroundContext) => Promise<void> };

/** How a runner plugin starts an agent: the command, its folder, environment and log file. */
export type Launch = { conversation: string; agent: string; argv: string[]; cwd: string; env: Record<string, string>; log: string };
export type Runner = {
  name: string;
  /** Start the agent's process; returns a handle the runner understands (a pane id, a block id). */
  start: (launch: Launch) => Promise<{ handle: string; pid: number | null }>;
  /** The agents of a conversation this runner has live, or null when it cannot tell. */
  alive: (conversation: string) => Promise<string[] | null>;
  stop: (conversation: string, agent: string) => Promise<void>;
};
export type BackgroundHook = (ctx: BackgroundContext) => Promise<void>;
export type PluginMemory = { title: string; text: (ctx: BackgroundContext) => Promise<string> };

export type PluginBackground = { watchers: Watcher[]; memory: PluginMemory | null; runner: Runner | null; stop: BackgroundHook | null; remove: BackgroundHook | null };

export function defineBackground(background: PluginBackground): PluginBackground {
  return background;
}

export type { MemorySection };
