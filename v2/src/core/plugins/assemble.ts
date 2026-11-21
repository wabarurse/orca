import { join } from "node:path";
import { pluginData } from "../bubbles";
import type { Bound, LoopHooks } from "../loop/hooks";
import { rolePrompt } from "../prompt";
import { CORE_TOOLS, type Tool } from "../tools/registry";
import { coreTools } from "../tools/mount";
import type { Role } from "../types";
import { enabledNames } from "./enable";
import { availablePlugins, type LoadedPlugin, type PluginProblem } from "./loader";
import type { Bundle, PluginContext } from "./types";
import { fail, ok, type Result } from "../../config";

export const BUILTIN_BUNDLES: Bundle[] = [
  { name: "orchestrator", role: "orchestrator", prompt: rolePrompt("orchestrator"), plugins: ["*"] },
  { name: "worker", role: "worker", prompt: rolePrompt("worker"), plugins: ["*"] },
  { name: "reviewer", role: "reviewer", prompt: rolePrompt("reviewer"), plugins: ["*"] },
];

export type Assembled = {
  bundle: Bundle;
  plugins: LoadedPlugin[];
  tools: Tool[];
  system: string;
  hooks: LoopHooks;
  skills: string[];
  problems: PluginProblem[];
};

export type AssembleInput = { conversation: string; agent: string; bundle: string; cwd: string; directory: string; trusted: boolean };

export async function assemble(input: AssembleInput): Promise<Result<Assembled>> {
  const { plugins: available, problems } = await availablePlugins(input.directory, input.trusted);
  const enabled = (await enabledNames(input.conversation)).flatMap(name => {
    const loaded = available.get(name);
    if (loaded === undefined && !problems.some(p => p.name === name)) problems.push({ name, dir: "", problem: "enabled but not installed" });
    return loaded === undefined ? [] : [loaded];
  });
  const bundles = [...BUILTIN_BUNDLES, ...enabled.flatMap(p => p.plugin.bundles)];
  const bundle = bundles.find(b => b.name === input.bundle);
  if (bundle === undefined) return fail(`no bundle ${input.bundle}; known: ${bundles.map(b => b.name).join(", ")}`);
  const used = bundle.plugins.includes("*") ? enabled : enabled.filter(p => bundle.plugins.includes(p.plugin.name));
  const role: Role = bundle.role;

  const tools = new Map<string, { tool: Tool; owner: string }>();
  for (const name of CORE_TOOLS[role]) {
    const tool = coreTools[name];
    if (tool !== undefined) tools.set(name, { tool, owner: "core" });
  }
  for (const loaded of used) {
    for (const entry of loaded.plugin.tools) {
      if (!entry.roles.includes(role)) continue;
      const name = entry.tool.spec.name;
      const existing = tools.get(name);
      if (existing !== undefined && existing.owner !== "core") { problems.push({ name: loaded.plugin.name, dir: loaded.dir, problem: `tool ${name} is already provided by ${existing.owner}` }); continue; }
      if (existing !== undefined && !entry.replaces) { problems.push({ name: loaded.plugin.name, dir: loaded.dir, problem: `tool ${name} would replace a core tool without replaces: true` }); continue; }
      tools.set(name, { tool: entry.tool, owner: loaded.plugin.name });
    }
  }

  const ctxFor = (loaded: LoadedPlugin): PluginContext => ({ plugin: loaded.plugin.name, conversation: input.conversation, agent: input.agent, role, cwd: input.cwd,
    data: scope => pluginData(input.conversation, loaded.plugin.name, scope) });
  const bind = <H>(pick: (loaded: LoadedPlugin) => H[]): Bound<H>[] => used.flatMap(loaded => pick(loaded).map(hook => ({ hook, ctx: ctxFor(loaded) })));
  const hooks: LoopHooks = {
    beforeTool: bind(l => l.plugin.hooks.beforeTool), afterTool: bind(l => l.plugin.hooks.afterTool),
    beforeRequest: bind(l => l.plugin.hooks.beforeRequest), onInput: bind(l => l.plugin.hooks.onInput),
    guard: used.flatMap(l => l.plugin.guard),
  };

  const additions = used.flatMap(loaded => loaded.plugin.prompt.filter(p => p.role === role).map(p => `[${loaded.plugin.name}] ${p.text}`));
  const storage = used.flatMap(loaded => loaded.plugin.storage.map(s => `- ${loaded.plugin.name} (${s.scope}): ${s.about}`));
  const system = [bundle.prompt, ...(additions.length > 0 ? ["Plugins:", ...additions] : []), ...(storage.length > 0 ? ["Plugin data under $ORCA_DATA:", ...storage] : [])].join("\n\n");
  const skills = used.flatMap(loaded => loaded.plugin.skills.map(skill => join(loaded.dir, skill)));
  return ok({ bundle, plugins: used, tools: [...tools.values()].map(t => t.tool), system, hooks, skills, problems });
}
