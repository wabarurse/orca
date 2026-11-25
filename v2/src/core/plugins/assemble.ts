import { join } from "node:path";
import { linksFor } from "./context";
import { pluginData } from "../bubbles";
import type { Bound, LoopHooks } from "../loop/hooks";
import { rolePrompt } from "../prompt";
import type { GuardRule } from "../tools/bash/guard";
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
];

export type Assembled = {
  bundle: Bundle;
  plugins: LoadedPlugin[];
  tools: Tool[];
  system: string;
  hooks: LoopHooks;
  guard: GuardRule[];
  skills: string[];
  problems: PluginProblem[];
};

export type AssembleInput = { conversation: string; agent: string; bundle: string; branch: string | null; cwd: string; directory: string; trusted: boolean };

const ownedBy = (tool: Tool, owner: string): Tool => ({ ...tool, run: (input, ctx) => tool.run(input, { ...ctx, links: linksFor(ctx.conversation, owner) }) });

export async function assemble(input: AssembleInput): Promise<Result<Assembled>> {
  const { plugins: available, problems } = await availablePlugins(input.directory, input.trusted);
  const enabled = (await enabledNames(input.conversation)).flatMap(name => {
    const loaded = available.get(name);
    if (loaded === undefined && !problems.some(p => p.name === name)) problems.push({ name, dir: "", problem: "enabled but not installed" });
    return loaded === undefined ? [] : [loaded];
  });
  const bundles = [...BUILTIN_BUNDLES, ...enabled.flatMap(p => p.plugin.bundles)];
  const name = input.bundle === "reviewer" && !bundles.some(b => b.name === "reviewer") ? "worker" : input.bundle;
  const bundle = bundles.find(b => b.name === name);
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
      tools.set(name, { tool: ownedBy(entry.tool, loaded.plugin.name), owner: loaded.plugin.name });
    }
  }

  const ctxFor = (loaded: LoadedPlugin): PluginContext => ({ plugin: loaded.plugin.name, conversation: input.conversation, agent: input.agent, role, branch: input.branch, cwd: input.cwd, links: linksFor(input.conversation, loaded.plugin.name),
    data: scope => pluginData(input.conversation, loaded.plugin.name, scope) });
  const bind = <H>(pick: (loaded: LoadedPlugin) => H[]): Bound<H>[] => used.flatMap(loaded => pick(loaded).map(hook => ({ hook, ctx: ctxFor(loaded) })));
  const hooks: LoopHooks = {
    beforeTool: bind(l => l.plugin.hooks.beforeTool), afterTool: bind(l => l.plugin.hooks.afterTool),
    beforeRequest: bind(l => l.plugin.hooks.beforeRequest), onInput: bind(l => l.plugin.hooks.onInput),
  };

  const additions = used.flatMap(loaded => loaded.plugin.prompt.filter(p => p.role === role).map(p => `[${loaded.plugin.name}] ${p.text}`));
  const storage = used.flatMap(loaded => loaded.plugin.storage.map(s => `- ${loaded.plugin.name} (${s.scope}): ${s.about}`));
  const roster = used.map(loaded => `- ${loaded.plugin.name}: ${loaded.plugin.description}`);
  const system = [bundle.prompt,
    ...(roster.length > 0 ? [`Plugins on in this bubble (${roster.length}; the user turns them on or off with Ctrl+P):`, ...roster] : []),
    ...(additions.length > 0 ? ["Plugin instructions:", ...additions] : []), ...(storage.length > 0 ? ["Plugin data under $ORCA_DATA:", ...storage] : [])].join("\n\n");
  const skills = used.flatMap(loaded => loaded.plugin.skills.map(skill => join(loaded.dir, skill)));
  return ok({ bundle, plugins: used, tools: [...tools.values()].map(t => t.tool), system, hooks, guard: used.flatMap(l => l.plugin.guard), skills, problems });
}
