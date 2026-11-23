import { join } from "node:path";
import type { Provider } from "../../api";
import { paths, type Result } from "../../config";
import { pluginData } from "../bubbles";
import type { Runtime, ToolContext } from "../tools/registry";
import type { PluginContext, UiHost } from "./types";

const idleProvider: Provider = {
  name: "anthropic",
  complete: async () => { throw new Error("no model in plugin tests"); },
  models: async () => [],
};

const idleRuntime: Runtime = {
  spawn: async () => { throw new Error("no spawn in plugin tests"); },
  agents: async () => [],
  stop: async () => "",
  confirm: async () => false,
};

export function toolContext(conversation: string, cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversation, agent: "orchestrator", role: "orchestrator", branch: null, cwd, data: join(paths.conversation(conversation), "data"),
    trusted: false, pluginSkills: [], guard: [], callId: "call-1", signal: new AbortController().signal, model: "test-model", provider: idleProvider,
    settings: null, runtime: idleRuntime, ...overrides,
  };
}

export function pluginContext(conversation: string, plugin: string, cwd: string, overrides: Partial<PluginContext> = {}): PluginContext {
  return { plugin, conversation, agent: "orchestrator", role: "orchestrator", branch: null, cwd, data: scope => pluginData(conversation, plugin, scope), ...overrides };
}

export type HostAnswers = { pick: number | null; input: string | null; confirm: boolean };
export type RecordingHost = { host: UiHost; said: string[]; notes: string[]; opened: string[] };

export function recordingHost(ctx: PluginContext, answers: HostAnswers): RecordingHost {
  const said: string[] = [], notes: string[] = [], opened: string[] = [];
  const host: UiHost = {
    ...ctx,
    note: text => { notes.push(text); },
    confirm: async () => answers.confirm,
    input: async () => answers.input,
    pick: async () => answers.pick,
    say: async text => { said.push(text); },
    open: async path => { opened.push(path); },
  };
  return { host, said, notes, opened };
}

export function item<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`no item ${index} in a list of ${list.length}`);
  return found;
}

export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
