import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { asRecord, errorMessage, fail, loadConfig, ok, paths, type Result } from "../../config";
import { RESERVED_DATA } from "../bubbles";
import { CORE_TOOL_NAMES } from "../tools/registry";
import { z } from "zod";
import type { Tool } from "../tools/registry";
import type { GuardInput } from "../tools/bash/guard";
import { RoleRecord } from "../roles";
import { registerPluginModules } from "./modules";
import type { AfterTool, BeforeRequest, BeforeTool, Listener, OnInput, Plugin, PluginBackground, PluginEvent, PluginUi, Retention, Service } from "./types";

export type PluginSource = "builtin" | "user" | "repo";

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
  ui: () => Promise<Result<PluginUi | null>>;
  background: () => Promise<Result<PluginBackground | null>>;
};

export type PluginProblem = { name: string; dir: string; problem: string };

let builtins: BuiltinPlugin[] = [];
export function registerBuiltins(list: BuiltinPlugin[]): void { builtins = list; }
export function builtinPlugins(): BuiltinPlugin[] { return builtins; }

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

export async function pluginHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder).catch((): string[] => [])).sort()) {
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
const fn = <T>() => z.custom<T>(isFn);
const RoleName = RoleRecord;
const ToolShape = z.object({ spec: z.looseObject({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }), run: z.custom(isFn), parallel: z.custom(isFn) });
const PluginRecord = z.object({
  name: z.string(), description: z.string(),
  tools: z.array(z.object({ tool: z.custom<Tool>(value => ToolShape.safeParse(value).success), roles: z.array(RoleName), replaces: z.boolean().catch(false) })),
  prompt: z.array(z.object({ role: RoleName, text: z.string() })),
  skills: z.array(z.string()),
  storage: z.array(z.object({ scope: z.enum(["conversation", "bubble", "global"]), about: z.string() })),
  hooks: z.object({ beforeTool: z.array(fn<BeforeTool>()), afterTool: z.array(fn<AfterTool>()), beforeRequest: z.array(fn<BeforeRequest>()), onInput: z.array(fn<OnInput>()) }),
  guard: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), group: z.enum(["efficiency", "security"]), test: fn<(call: GuardInput) => boolean>(),
    reason: z.string().min(1), suggest: fn<(call: GuardInput) => string>() })).default([]),
  bundles: z.array(z.object({ name: z.string(), role: RoleName, prompt: z.string(), plugins: z.array(z.string()) })),
  retention: z.array(z.object({ tab: z.string().min(1), archiveAfterDays: z.number().positive().nullable(), purgeAfterDays: z.number().positive(),
    settled: fn<Retention["settled"]>(), locate: fn<Retention["locate"]>(), purge: fn<Retention["purge"]>() })).default([]),
  provides: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), about: z.string(), run: fn<Service["run"]>() })).default([]),
  uses: z.array(z.string()).default([]),
  emits: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), about: z.string(), check: fn<PluginEvent["check"]>() })).default([]),
  on: z.array(z.object({ event: z.string().regex(/^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}$/), run: fn<Listener["run"]>() })).default([]),
  ui: z.string().nullable(), background: z.string().nullable(),
});
const UiShape = z.object({ tabs: z.array(z.unknown()), counts: z.array(z.unknown()), commands: z.array(z.unknown()), toolLines: z.record(z.string(), z.unknown()), folds: z.record(z.string(), z.unknown()) });
const BackgroundShape = z.object({ watchers: z.array(z.unknown()), memory: z.unknown(), runner: z.unknown(), stop: z.unknown(), remove: z.unknown() });
const UiModule = z.custom<PluginUi>(value => UiShape.safeParse(value).success);
const BackgroundModule = z.custom<PluginBackground>(value => BackgroundShape.safeParse(value).success);

const listOf = (value: unknown): unknown[] | null => Array.isArray(value) ? value : null;
const field = (value: unknown, key: string): unknown => {
  const record = asRecord(value);
  return record === null ? undefined : record[key];
};

function pluginProblem(p: Record<string, unknown>, folder: string): string | null {
  if (typeof p.name !== "string" || !NAME.test(p.name)) return "name must be lowercase letters, digits and dashes";
  if (RESERVED_DATA.includes(p.name)) return `name "${p.name}" is reserved for $ORCA_DATA/${p.name}`;
  if (p.name !== folder) return `name "${p.name}" must match its folder "${folder}"`;
  if (typeof p.description !== "string" || p.description.length === 0) return "description is required";
  for (const key of ["tools", "prompt", "skills", "storage", "bundles"]) if (listOf(p[key]) === null) return `${key} must be a list`;
  const hooks = asRecord(p.hooks);
  if (hooks === null || ["beforeTool", "afterTool", "beforeRequest", "onInput"].some(key => !(listOf(hooks[key])?.every(isFn) ?? false))) return "hooks must have beforeTool, afterTool, beforeRequest and onInput lists of functions";
  if (p.ui !== null && typeof p.ui !== "string") return "ui must be a path or null";
  if (p.background !== null && typeof p.background !== "string") return "background must be a path or null";
  const names = new Set<string>();
  for (const entry of listOf(p.tools) ?? []) {
    const tool = field(entry, "tool");
    const name = field(field(tool, "spec"), "name");
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) return "each tool needs a spec.name of lowercase letters, digits and underscores";
    if (!isFn(field(tool, "run")) || !isFn(field(tool, "parallel"))) return `tool ${name} needs run and parallel functions`;
    const roles = listOf(field(entry, "roles"));
    if (roles === null || roles.length === 0) return `tool ${name} needs at least one role`;
    if (CORE_TOOL_NAMES.some(core => core === name) && field(entry, "replaces") !== true) return `tool ${name} has a core tool's name; set replaces: true to replace it`;
    if (names.has(name)) return `tool ${name} is defined twice`;
    names.add(name);
  }
  for (const bundle of listOf(p.bundles) ?? []) {
    const name = field(bundle, "name"), role = field(bundle, "role");
    if (typeof name !== "string" || !NAME.test(name) || typeof role !== "string" || !RoleRecord.safeParse(role).success) return "each bundle needs a name and a role";
  }
  return null;
}

export function validatePlugin(value: unknown, folder: string): Result<Plugin> {
  const p = typeof value === "object" && value !== null ? asRecord({ ...value }) : null;
  if (p === null) return fail("index.ts must default-export definePlugin({...})");
  const problem = pluginProblem(p, folder);
  if (problem !== null) return fail(problem);
  const parsed = PluginRecord.safeParse(p);
  if (!parsed.success) return fail(`invalid plugin: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return ok(parsed.data);
}

const moduleDefault = (module: unknown): unknown => typeof module === "object" && module !== null && "default" in module ? module.default : undefined;

async function importModule(file: string): Promise<Result<unknown>> {
  registerPluginModules();
  try {
    const module: unknown = await import(file);
    return ok(module);
  } catch (error) { return fail(errorMessage(error)); }
}

async function loadFolder(dir: string, name: string, source: PluginSource): Promise<Result<LoadedPlugin>> {
  const module = await importModule(join(dir, "index.ts"));
  if (!module.ok) return module;
  const plugin = validatePlugin(moduleDefault(module.data), name);
  if (!plugin.ok) return plugin;
  const sub = <T>(path: string | null, schema: z.ZodType<T>, what: string) => async (): Promise<Result<T | null>> => {
    if (path === null) return ok(null);
    const loaded = await importModule(join(dir, path));
    if (!loaded.ok) return fail(`${name}: ${path} does not load: ${loaded.error}`);
    const parsed = schema.safeParse(moduleDefault(loaded.data));
    return parsed.success ? ok(parsed.data) : fail(`${name}: ${path} must default-export ${what}({...})`);
  };
  return ok({ plugin: plugin.data, dir, source, ui: sub(plugin.data.ui, UiModule, "defineUi"), background: sub(plugin.data.background, BackgroundModule, "defineBackground") });
}

async function folders(root: string): Promise<string[]> {
  const names = await readdir(root).catch((): string[] => []);
  const out: string[] = [];
  for (const name of names.sort()) if (NAME.test(name) && await Bun.file(join(root, name, "index.ts")).exists()) out.push(name);
  return out;
}

export type Available = { plugins: Map<string, LoadedPlugin>; problems: PluginProblem[] };

export async function availablePlugins(directory: string | null, trusted: boolean): Promise<Available> {
  const plugins = new Map<string, LoadedPlugin>();
  const problems: PluginProblem[] = [];
  const config = await loadConfig();
  for (const builtin of builtins) {
    try {
      const plugin = validatePlugin((await builtin.index()).default, builtin.name);
      if (!plugin.ok) { problems.push({ name: builtin.name, dir: builtin.dir, problem: plugin.error }); continue; }
      const ui = builtin.ui, background = builtin.background;
      plugins.set(builtin.name, { plugin: plugin.data, dir: builtin.dir, source: "builtin",
        ui: async () => ui === null ? ok(null) : ui().then(module => ok(module.default), (error: unknown) => fail(`${builtin.name}: ui does not load: ${errorMessage(error)}`)),
        background: async () => background === null ? ok(null) : background().then(module => ok(module.default), (error: unknown) => fail(`${builtin.name}: background does not load: ${errorMessage(error)}`)) });
    } catch (error) { problems.push({ name: builtin.name, dir: builtin.dir, problem: errorMessage(error) }); }
  }
  const roots: { root: string; source: PluginSource }[] = [{ root: paths.plugins, source: "user" }];
  if (trusted && directory !== null) roots.push({ root: join(directory, ".orca2", "plugins"), source: "repo" });
  const visited = new Set<string>();
  for (const { root, source } of roots) {
    const location = await realpath(root).catch(() => root);
    if (visited.has(location)) continue;
    visited.add(location);
    for (const name of await folders(root)) {
      const dir = join(root, name);
      if (source === "user" && plugins.get(name)?.source === "builtin") continue;
      if (plugins.has(name)) { problems.push({ name, dir, problem: `a plugin named ${name} is already loaded` }); continue; }
      if (source === "user" && !config.approved.includes(`${name}@${await pluginHash(dir)}`)) {
        const changed = config.approved.some(pin => pin.startsWith(`${name}@`));
        problems.push({ name, dir, problem: changed ? `not approved (changed): run orca2 plugin update ${name}` : `not approved (new): run orca2 plugin enable ${name}` });
        continue;
      }
      const loaded = await loadFolder(dir, name, source);
      if (loaded.ok) plugins.set(name, loaded.data);
      else problems.push({ name, dir, problem: loaded.error });
    }
  }
  return { plugins, problems };
}

export async function loadForCheck(dir: string, name: string): Promise<Result<LoadedPlugin>> {
  return loadFolder(dir, name, "user");
}
