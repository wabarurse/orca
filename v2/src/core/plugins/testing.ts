import { join } from "node:path";
import type { Provider } from "../../api";
import { paths, type Result } from "../../config";
import { pluginData } from "../bubbles";
import type { Runtime, ToolContext } from "../tools/registry";
import { linksFor } from "./context";
import type { Attach, Links, PluginContext, UiHost } from "./types";

const idleProvider: Provider = {
  name: "anthropic",
  complete: async () => { throw new Error("no model in plugin tests"); },
  models: async () => [],
};

export const noLinks: Links = {
  call: async () => ({ ok: false, error: "no plugin links in this test" }),
  emit: async () => ({ ok: true, data: 0 }),
  runner: async () => { const { plainRunner } = await import("../runner/plain"); return plainRunner; },
  runnerNamed: async () => null,
};

const idleRuntime: Runtime = {
  spawn: async () => { throw new Error("no spawn in plugin tests"); },
  agents: async () => [],
  stop: async () => "",
  show: async () => "",
  confirm: async () => false,
};

export function toolContext(conversation: string, cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversation, agent: "orchestrator", role: "orchestrator", branch: null, cwd, data: join(paths.conversation(conversation), "data"),
    trusted: false, pluginSkills: [], guard: [], callId: "call-1", signal: new AbortController().signal, model: "test-model", provider: idleProvider,
    settings: null, runtime: idleRuntime, links: linksFor(conversation, "test"), ...overrides,
  };
}

export function pluginContext(conversation: string, plugin: string, cwd: string, overrides: Partial<PluginContext> = {}): PluginContext {
  return { plugin, conversation, agent: "orchestrator", role: "orchestrator", branch: null, cwd, data: scope => pluginData(conversation, plugin, scope), links: linksFor(conversation, plugin), ...overrides };
}

export type HostAnswers = { pick: number | null; input: string | null; confirm: boolean };
export type Picked = { title: string; options: string[]; current: number | null; digits: boolean };
export type RecordingHost = { host: UiHost; said: string[]; notes: string[]; opened: string[]; attached: Attach[]; picked: Picked[] };

export function recordingHost(ctx: PluginContext, answers: HostAnswers): RecordingHost {
  const said: string[] = [], notes: string[] = [], opened: string[] = [], attached: Attach[] = [], picked: Picked[] = [];
  const host: UiHost = {
    ...ctx,
    note: text => { notes.push(text); },
    confirm: async () => answers.confirm,
    input: async () => answers.input,
    pick: async (title, options, opts) => { picked.push({ title, options, current: opts?.current ?? null, digits: opts?.digits === true }); return answers.pick; },
    say: async text => { said.push(text); },
    open: async path => { opened.push(path); },
    attach: async plan => { attached.push(plan); },
  };
  return { host, said, notes, opened, attached, picked };
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
