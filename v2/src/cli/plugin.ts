// `orca2 plugin new|check|enable|disable|list`: the plugin dev loop an agent (or the user) runs. A plugin runs with
// the user's permissions, so enabling a plugin someone other than the user wrote always asks the user, at a
// terminal, showing what it adds; nothing enables itself.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadConfig, paths, saveConfig } from "../config";
import { ensureBubble, setBubblePlugin } from "../core/bubbles";
import { conversationFor } from "../core/conversations";
import { availablePlugins, builtinPlugins, loadForCheck, pluginHash, type LoadedPlugin } from "../core/plugins";
import { pluginTemplate } from "./template";

type Out = (text: string) => void;
type Ask = (question: string) => Promise<boolean>;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const APP_ROOT = resolve(import.meta.dir, "../..");

function option(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
}

function locate(target: string): string | null {
  if (target.includes("/") || target.startsWith(".")) return existsSync(join(resolve(target), "index.ts")) ? resolve(target) : null;
  const user = join(paths.plugins, target);
  if (existsSync(join(user, "index.ts"))) return user;
  return builtinPlugins().find(p => p.name === target)?.dir ?? null;
}

/** What a plugin adds, for the approval question and `plugin list`. */
export async function describePlugin(loaded: LoadedPlugin): Promise<string[]> {
  const p = loaded.plugin;
  const ui = await loaded.ui();
  const background = await loaded.background();
  const hooks = Object.entries(p.hooks).filter(([, list]) => list.length > 0).map(([name, list]) => `${name} ×${list.length}`);
  return [
    `${p.name}: ${p.description}`,
    `  tools: ${p.tools.length > 0 ? p.tools.map(t => `${t.tool.spec.name} (${t.roles.join(", ")}${t.replaces ? ", replaces core" : ""})`).join("; ") : "none"}`,
    `  hooks: ${hooks.length > 0 ? hooks.join(", ") : "none"}`,
    `  storage: ${p.storage.length > 0 ? p.storage.map(s => `${s.scope}: ${s.about}`).join("; ") : "none"}`,
    `  bundles: ${p.bundles.length > 0 ? p.bundles.map(b => `${b.name} (${b.role})`).join(", ") : "none"}`,
    `  ui: ${ui === null ? "none" : `tabs ${ui.tabs.map(t => t.title).join(", ") || "none"}; commands ${ui.commands.map(c => `/${c.name}`).join(", ") || "none"}; counts ${ui.counts.length}`}`,
    `  background: ${background === null ? "none" : `watchers ${background.watchers.map(w => w.name).join(", ") || "none"}${background.runner === null ? "" : `; runner ${background.runner.name}`}${background.memory === null ? "" : `; memory section "${background.memory.title}"`}`}`,
    `  folder: ${loaded.dir}`,
  ];
}

async function newPlugin(args: string[], out: Out): Promise<number> {
  const name = args[0] ?? "";
  if (!NAME.test(name)) { out("usage: orca2 plugin new <name> [--dir <folder>]  (name: lowercase letters, digits, dashes)\n"); return 2; }
  const dir = resolve(option(args, "--dir") ?? join(paths.plugins, name));
  if (existsSync(dir)) { out(`${dir} already exists\n`); return 1; }
  await mkdir(join(dir, "skills"), { recursive: true });
  for (const [file, text] of Object.entries(pluginTemplate(name))) await writeFile(join(dir, file), text);
  out(`created ${dir}\nnext: edit index.ts, then orca2 plugin check ${dir}\n`);
  return 0;
}

async function run(argv: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: (stdout + stderr).trim() };
}

export async function checkPlugin(args: string[], out: Out): Promise<number> {
  const target = args[0] ?? "";
  const dir = locate(target);
  if (dir === null) { out(`no plugin folder for ${JSON.stringify(target)} (a path, a user plugin or a built-in name)\n`); return 2; }
  const name = basename(dir);
  const home = await mkdtemp(join(tmpdir(), "orca2-plugin-check-"));
  const previous = process.env.ORCA2_HOME;
  process.env.ORCA2_HOME = home;
  let failures = 0;
  const fail = (text: string): void => { failures++; out(`FAIL ${text}\n`); };
  try {
    let loaded: LoadedPlugin | null = null;
    try { loaded = await loadForCheck(dir, name); out(`ok   loads: ${loaded.plugin.name}\n`); }
    catch (error) { fail(`load: ${error instanceof Error ? error.message : String(error)}`); }
    if (loaded !== null) {
      try { for (const line of await describePlugin(loaded)) out(`     ${line}\n`); }
      catch (error) { fail(`ui/background: ${error instanceof Error ? error.message : String(error)}`); }
      for (const skill of loaded.plugin.skills) if (!existsSync(join(dir, skill, "SKILL.md"))) fail(`skill folder ${skill} has no SKILL.md`);
    }
    const tsc = ["tsc", "tsc6"].map(name => join(APP_ROOT, "node_modules", "typescript", "bin", name)).find(path => existsSync(path)) ?? "";
    if (tsc.length > 0) {
      const config = join(home, "tsconfig.json");
      await writeFile(config, JSON.stringify({ compilerOptions: { lib: ["ESNext"], target: "ESNext", module: "Preserve", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true,
        noUncheckedIndexedAccess: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, types: ["bun"], typeRoots: [join(APP_ROOT, "node_modules", "@types")],
        paths: { "orca2/plugin": [join(APP_ROOT, "src/core/plugins/api.ts")] } }, include: [join(dir, "**/*.ts"), join(APP_ROOT, "src/md.d.ts")] }));
      const result = await run([process.execPath.endsWith("bun") ? process.execPath : Bun.which("bun") ?? process.execPath, tsc, "-p", config], dir, { ...process.env, ORCA2_HOME: home } as Record<string, string>);
      if (result.code === 0) out("ok   types\n"); else fail(`types:\n${result.out}`);
    } else out("skip types (no TypeScript next to this orca2)\n");
    const tests = (await readdir(dir, { recursive: true })).filter(file => String(file).endsWith(".test.ts") && !String(file).includes("node_modules"));
    const bun = process.execPath.endsWith("bun") ? process.execPath : Bun.which("bun");
    if (tests.length > 0 && bun === null) out("skip tests (bun is not on PATH)\n");
    else if (tests.length > 0 && bun !== null) {
      const result = await run([bun, "test", ...tests.map(file => `./${String(file)}`)], dir, { ...process.env, ORCA2_HOME: home } as Record<string, string>);
      if (result.code === 0) out(`ok   tests (${tests.length} file${tests.length === 1 ? "" : "s"})\n`); else fail(`tests:\n${result.out}`);
    } else out("note no tests (add <name>.test.ts beside index.ts)\n");
  } finally {
    if (previous === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
  out(failures === 0 ? `${name}: all checks passed\n` : `${name}: ${failures} check${failures === 1 ? "" : "s"} failed\n`);
  return failures === 0 ? 0 : 1;
}

async function scopeBubble(args: string[]): Promise<string | null> {
  if (!args.includes("--bubble")) return null;
  const given = option(args, "--bubble");
  if (given !== null && given.startsWith("bubble-")) return given;
  return (await ensureBubble((await conversationFor(process.cwd())).id)).id;
}

export async function enablePlugin(args: string[], out: Out, ask: Ask, interactive: boolean): Promise<number> {
  const name = args[0] ?? "";
  const from = option(args, "--from");
  if (from !== null) {
    if (!existsSync(join(resolve(from), "index.ts"))) { out(`${from} has no index.ts\n`); return 2; }
    await rm(join(paths.plugins, name), { recursive: true, force: true });
    await mkdir(paths.plugins, { recursive: true });
    await cp(resolve(from), join(paths.plugins, name), { recursive: true, filter: source => !source.includes("node_modules") });
  }
  const builtin = builtinPlugins().some(p => p.name === name);
  if (!builtin) {
    const dir = join(paths.plugins, name);
    if (!existsSync(join(dir, "index.ts"))) { out(`no plugin ${name} (built-in or in ${paths.plugins})\n`); return 2; }
    const config = await loadConfig();
    const pinned = `${name}@${await pluginHash(dir)}`;
    if (!config.approved.includes(pinned)) {
      if (!interactive) { out(`refused: enabling ${name} needs the user's approval at a terminal (run orca2 plugin enable ${name} yourself)\n`); return 3; }
      let loaded: LoadedPlugin;
      try { loaded = await loadForCheck(dir, name); }
      catch (error) { out(`${name} does not load: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
      out(`${(await describePlugin(loaded)).join("\n")}\nIt will run with your permissions.\n`);
      if (!await ask(`Approve and enable ${name}?`)) { out("not enabled\n"); return 1; }
      await saveConfig({ approved: [...config.approved.filter(entry => !entry.startsWith(`${name}@`)), pinned] });
    }
  }
  const bubble = await scopeBubble(args);
  if (bubble !== null) { await setBubblePlugin(bubble, name, "on"); out(`${name} on for ${bubble}\n`); return 0; }
  const config = await loadConfig();
  if (!config.plugins.includes(name)) await saveConfig({ plugins: [...config.plugins, name].sort() });
  out(`${name} enabled (applies to the next agent or orchestrator turn)\n`);
  return 0;
}

async function disablePlugin(args: string[], out: Out): Promise<number> {
  const name = args[0] ?? "";
  const bubble = await scopeBubble(args);
  if (bubble !== null) { await setBubblePlugin(bubble, name, "off"); out(`${name} off for ${bubble}\n`); return 0; }
  const config = await loadConfig();
  await saveConfig({ plugins: config.plugins.filter(p => p !== name) });
  out(`${name} disabled\n`);
  return 0;
}

async function listPlugins(out: Out): Promise<number> {
  const config = await loadConfig();
  const { plugins, problems } = await availablePlugins(process.cwd(), false);
  for (const loaded of plugins.values()) out(`${config.plugins.includes(loaded.plugin.name) ? "on " : "   "} ${loaded.plugin.name.padEnd(14)} ${loaded.source.padEnd(8)} ${loaded.plugin.description}\n`);
  for (const problem of problems) out(`!!  ${problem.name.padEnd(14)} ${problem.problem}\n`);
  return 0;
}

export const PLUGIN_USAGE = `orca2 plugin list
  orca2 plugin new <name> [--dir <folder>]       a plugin folder from the template
  orca2 plugin check <name|folder>               load, type-check and test it against a temporary home
  orca2 plugin enable <name> [--from <folder>] [--bubble [id]]   asks you first for a plugin you did not write
  orca2 plugin disable <name> [--bubble [id]]`;

export async function runPlugin(args: string[], out: Out, ask: Ask, interactive: boolean): Promise<number> {
  const [action, ...rest] = args;
  if (action === "new") return newPlugin(rest, out);
  if (action === "check") return checkPlugin(rest, out);
  if (action === "enable") return enablePlugin(rest, out, ask, interactive);
  if (action === "disable") return disablePlugin(rest, out);
  if (action === "list" || action === undefined) return listPlugins(out);
  out(`usage:\n  ${PLUGIN_USAGE}\n`);
  return 2;
}
