// Finding and loading plugins. Built-in plugins are registered by the CLI (src/plugins/index.ts); user plugins live
// in ~/.orca2/plugins/<name>/ and load only once the user approved that exact content; a trusted folder's plugins
// (.orca2/plugins/<name>/) load because the user trusted the folder. A plugin runs with the user's permissions.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig, paths } from "../../config";
import { CORE_TOOL_NAMES } from "../tools/registry";
import type { Plugin, PluginBackground, PluginUi } from "./types";

export type PluginSource = "builtin" | "user" | "repo";

/** A built-in plugin: its modules are imported statically so the compiled binary carries them. */
export type BuiltinPlugin = {
  name: string;
  dir: string;
  index: () => Promise<{ default: Plugin }>;
  ui: (() => Promise<{ default: PluginUi }>) | null;
  background: (() => Promise<{ default: PluginBackground }>) | null;
};

export type LoadedPlugin = {
  plugin: Plugin;
  dir: string;
  source: PluginSource;
  ui: () => Promise<PluginUi | null>;
  background: () => Promise<PluginBackground | null>;
};

export type PluginProblem = { name: string; dir: string; problem: string };

let builtins: BuiltinPlugin[] = [];
export function registerBuiltins(list: BuiltinPlugin[]): void { builtins = list; }
export function builtinPlugins(): BuiltinPlugin[] { return builtins; }

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** sha256 over every file of the plugin folder (paths and contents, node_modules excluded): what approval pins. */
export async function pluginHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder).catch(() => [] as string[])).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(folder, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) hash.update(relative(dir, path)).update("\0").update(new Uint8Array(await Bun.file(path).arrayBuffer())).update("\0");
    }
  };
  await walk(dir);
  return hash.digest("hex").slice(0, 16);
}

const isFn = (value: unknown): boolean => typeof value === "function";
const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** Structural check of what index.ts exported: every field present, names and tools well-formed. */
export function validatePlugin(value: unknown, folder: string): Plugin {
  const p = value as Partial<Plugin> | null;
  if (p === null || typeof p !== "object") throw new Error("index.ts must default-export definePlugin({...})");
  if (typeof p.name !== "string" || !NAME.test(p.name)) throw new Error("name must be lowercase letters, digits and dashes");
  if (p.name !== folder) throw new Error(`name "${p.name}" must match its folder "${folder}"`);
  if (typeof p.description !== "string" || p.description.length === 0) throw new Error("description is required");
  for (const key of ["tools", "prompt", "skills", "storage", "bundles"] as const) if (!isList(p[key])) throw new Error(`${key} must be a list`);
  const hooks = p.hooks as Record<string, unknown> | undefined;
  if (hooks === undefined || ["beforeTool", "afterTool", "beforeRequest", "onInput"].some(key => !isList(hooks[key]) || !(hooks[key] as unknown[]).every(isFn))) throw new Error("hooks must have beforeTool, afterTool, beforeRequest and onInput lists of functions");
  if (p.ui !== null && typeof p.ui !== "string") throw new Error("ui must be a path or null");
  if (p.background !== null && typeof p.background !== "string") throw new Error("background must be a path or null");
  const names = new Set<string>();
  for (const entry of p.tools ?? []) {
    const name = entry.tool?.spec?.name;
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error("each tool needs a spec.name of lowercase letters, digits and underscores");
    if (!isFn(entry.tool.run) || !isFn(entry.tool.parallel)) throw new Error(`tool ${name} needs run and parallel functions`);
    if (!isList(entry.roles) || entry.roles.length === 0) throw new Error(`tool ${name} needs at least one role`);
    if ((CORE_TOOL_NAMES as readonly string[]).includes(name) && entry.replaces !== true) throw new Error(`tool ${name} has a core tool's name; set replaces: true to replace it`);
    if (names.has(name)) throw new Error(`tool ${name} is defined twice`);
    names.add(name);
  }
  for (const bundle of p.bundles ?? []) if (typeof bundle.name !== "string" || !NAME.test(bundle.name) || !["orchestrator", "worker", "reviewer"].includes(bundle.role)) throw new Error("each bundle needs a name and a role");
  return p as Plugin;
}

async function loadFolder(dir: string, name: string, source: PluginSource): Promise<LoadedPlugin> {
  const module = await import(join(dir, "index.ts")) as { default?: unknown };
  const plugin = validatePlugin(module.default, name);
  const sub = <T>(path: string | null) => async (): Promise<T | null> => path === null ? null : ((await import(join(dir, path)) as { default: T }).default);
  return { plugin, dir, source, ui: sub<PluginUi>(plugin.ui), background: sub<PluginBackground>(plugin.background) };
}

async function folders(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) if (NAME.test(name) && await Bun.file(join(root, name, "index.ts")).exists()) out.push(name);
  return out;
}

export type Available = { plugins: Map<string, LoadedPlugin>; problems: PluginProblem[] };

/** Every plugin that can load here: built-ins, approved user plugins and (when trusted) the folder's own. */
export async function availablePlugins(directory: string | null, trusted: boolean): Promise<Available> {
  const plugins = new Map<string, LoadedPlugin>();
  const problems: PluginProblem[] = [];
  const config = await loadConfig();
  for (const builtin of builtins) {
    try {
      const plugin = validatePlugin((await builtin.index()).default, builtin.name);
      const ui = builtin.ui, background = builtin.background;
      plugins.set(builtin.name, { plugin, dir: builtin.dir, source: "builtin",
        ui: async () => ui === null ? null : (await ui()).default, background: async () => background === null ? null : (await background()).default });
    } catch (error) { problems.push({ name: builtin.name, dir: builtin.dir, problem: error instanceof Error ? error.message : String(error) }); }
  }
  const roots: { root: string; source: PluginSource }[] = [{ root: paths.plugins, source: "user" }];
  if (trusted && directory !== null) roots.push({ root: join(directory, ".orca2", "plugins"), source: "repo" });
  for (const { root, source } of roots) {
    for (const name of await folders(root)) {
      const dir = join(root, name);
      if (plugins.has(name)) { problems.push({ name, dir, problem: `a plugin named ${name} is already loaded` }); continue; }
      if (source === "user" && !config.approved.includes(`${name}@${await pluginHash(dir)}`)) {
        problems.push({ name, dir, problem: `not approved (new or changed): run orca2 plugin enable ${name}` });
        continue;
      }
      try { plugins.set(name, await loadFolder(dir, name, source)); }
      catch (error) { problems.push({ name, dir, problem: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return { plugins, problems };
}

/** Load one plugin folder for checking, without approval (orca2 plugin check). */
export async function loadForCheck(dir: string, name: string): Promise<LoadedPlugin> {
  return loadFolder(dir, name, "user");
}
