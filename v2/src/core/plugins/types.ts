import type { MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { GuardRule } from "../tools/bash/guard";
import type { MemorySection } from "../loop/rolling";
import type { Tool, ToolResult } from "../tools/registry";
import type { Message, Role } from "../types";
import type { Result } from "../../config";

export type StorageScope = "conversation" | "bubble" | "global";

export type PluginContext = {
  plugin: string;
  conversation: string;
  agent: string;
  role: Role;
  cwd: string;
  data: (scope: StorageScope) => Promise<Result<string>>;
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

export type PluginTool = { tool: Tool; roles: Role[]; replaces: boolean };

export type Bundle = { name: string; role: Role; prompt: string; plugins: string[] };

export type SettledItem = { id: string; at: string };
export type Retention = {
  tab: string;
  archiveAfterDays: number | null;
  purgeAfterDays: number;
  settled: (ctx: BackgroundContext) => Promise<SettledItem[]>;
  locate: (id: string, ctx: BackgroundContext) => Promise<string | null>;
  purge: (ids: string[], ctx: BackgroundContext) => Promise<void>;
};

export type Plugin = {
  name: string;
  description: string;
  tools: PluginTool[];
  prompt: { role: Role; text: string }[];
  skills: string[];
  storage: { scope: StorageScope; about: string }[];
  hooks: PluginHooks;
  guard: GuardRule[];
  bundles: Bundle[];
  retention: Retention[];
  ui: string | null;
  background: string | null;
};

export const noHooks = (): PluginHooks => ({ beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] });

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

export type Tone = "normal" | "good" | "warn" | "bad" | "dim";
export type Row = { id: string; name: string; status: string; info: string; tone: Tone };
export type Section = { title: string; lines: string[] };

export type UiHost = PluginContext & {
  note: (text: string) => void;
  confirm: (question: string) => Promise<boolean>;
  input: (prompt: string, initial: string) => Promise<string | null>;
  pick: (title: string, options: string[]) => Promise<number | null>;
  say: (text: string) => Promise<void>;
};

export type TabAction = { key: string; label: string; run: (row: Row | null, host: UiHost) => Promise<void> };
export type Tab = {
  id: string;
  title: string;
  chord: string | null;
  rows: (ctx: PluginContext) => Promise<Row[]>;
  details: (row: Row, ctx: PluginContext) => Promise<Section[]>;
  actions: TabAction[];
};
export type Count = { id: string; count: (ctx: PluginContext) => Promise<number | null>; label: (n: number) => string };
export type Command = { name: string; description: string; run: (args: string, host: UiHost) => Promise<void> };
export type ToolLine = { label: (input: Record<string, unknown>) => string; summary: (outcome: { ok: boolean; text: string }) => { summary: string; failed: boolean } };
export type Fold = { title: (n: number) => string; items: (input: Record<string, unknown>, outcome: { ok: boolean; text: string }) => string[]; opens: string | null };

export type PluginUi = { tabs: Tab[]; counts: Count[]; commands: Command[]; toolLines: Record<string, ToolLine>; folds: Record<string, Fold> };

export function defineUi(ui: PluginUi): PluginUi {
  return ui;
}

export type BackgroundContext = Omit<PluginContext, "agent" | "role" | "cwd"> & {
  directory: string;
  notify: (text: string) => Promise<void>;
};
export type Watcher = { name: string; everyMs: number; run: (ctx: BackgroundContext) => Promise<void> };

export type Launch = { conversation: string; agent: string; argv: string[]; cwd: string; env: Record<string, string>; log: string };
export type Runner = {
  name: string;
  start: (launch: Launch) => Promise<{ handle: string; pid: number | null }>;
  alive: (conversation: string) => Promise<string[] | null>;
  stop: (conversation: string, agent: string) => Promise<void>;
};
export type BackgroundHook = (ctx: BackgroundContext) => Promise<void>;
export type PluginMemory = { title: string; text: (ctx: BackgroundContext) => Promise<string> };

export type PluginBackground = { watchers: Watcher[]; memory: PluginMemory | null; runner: Runner | null; stop: BackgroundHook | null; remove: BackgroundHook | null };

export function defineBackground(background: PluginBackground): PluginBackground {
  return background;
}

export type { GuardInput, ShellCommand } from "../tools/bash/guard";
export type { GuardRule, MemorySection, Result };
