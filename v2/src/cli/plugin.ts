import { pluginSettings, setPluginSetting } from "../core/plugins/settings";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fail, loadConfig, ok, parseJson, paths, saveConfig, type Result } from "../config";
import { ensureBubble, readBubble, setBubblePlugin, type Bubble } from "../core/bubbles";
import { withStorageLock } from "../core/lock";
import { trustState } from "../core/trust";
import { conversationFor, listConversations, readConversation } from "../core/conversations";
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

export async function describePlugin(loaded: LoadedPlugin): Promise<Result<string[]>> {
  const p = loaded.plugin;
  const loadedUi = await loaded.ui();
  if (!loadedUi.ok) return loadedUi;
  const loadedBackground = await loaded.background();
  if (!loadedBackground.ok) return loadedBackground;
  const ui = loadedUi.data, background = loadedBackground.data;
  const listed = (names: string[]): string => names.length > 0 ? names.join(", ") : "none";
  const hooks = Object.entries(p.hooks).filter(([, list]) => list.length > 0).map(([name, list]) => `${name} ×${list.length}`);
  return ok([
    `${p.name}: ${p.description}`,
    `  tools: ${p.tools.length > 0 ? p.tools.map(t => `${t.tool.spec.name} (${t.roles.join(", ")}${t.replaces ? ", replaces core" : ""})`).join("; ") : "none"}`,
    `  hooks: ${hooks.length > 0 ? hooks.join(", ") : "none"}`,
    `  guard: ${listed(p.guard.map(rule => rule.id))}`,
    `  storage: ${p.storage.length > 0 ? p.storage.map(s => `${s.scope}: ${s.about}`).join("; ") : "none"}`,
    `  bundles: ${p.bundles.length > 0 ? p.bundles.map(b => `${b.name} (${b.role})`).join(", ") : "none"}`,
    `  ui: ${ui === null ? "none" : `tabs ${listed(ui.tabs.map(t => t.title))}; commands ${listed(ui.commands.map(c => `/${c.name}`))}; counts ${ui.counts.length}`}`,
    `  background: ${background === null ? "none" : `watchers ${listed(background.watchers.map(w => w.name))}${background.runner === null ? "" : `; runner ${background.runner.name}`}${background.memory === null ? "" : `; memory section "${background.memory.title}"`}`}`,
    `  folder: ${loaded.dir}`,
  ]);
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

async function run(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
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
    const loading = await loadForCheck(dir, name);
    const loaded: LoadedPlugin | null = loading.ok ? loading.data : null;
    if (loading.ok) out(`ok   loads: ${loading.data.plugin.name}\n`);
    else fail(`load: ${loading.error}`);
    if (loaded !== null) {
      const described = await describePlugin(loaded);
      if (described.ok) for (const line of described.data) out(`     ${line}\n`);
      else fail(`ui/background: ${described.error}`);
      for (const skill of loaded.plugin.skills) if (!existsSync(join(dir, skill, "SKILL.md"))) fail(`skill folder ${skill} has no SKILL.md`);
    }
    const tsc = ["tsc", "tsc6"].map(name => join(APP_ROOT, "node_modules", "typescript", "bin", name)).find(path => existsSync(path)) ?? "";
    if (tsc.length > 0) {
      const config = join(home, "tsconfig.json");
      await writeFile(config, JSON.stringify({ compilerOptions: { lib: ["ESNext"], target: "ESNext", module: "Preserve", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true,
        noUncheckedIndexedAccess: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, types: ["bun"], typeRoots: [join(APP_ROOT, "node_modules", "@types")],
        paths: { "orca2/plugin": [join(APP_ROOT, "src/core/plugins/api.ts")], "orca2/plugin/testing": [join(APP_ROOT, "src/core/plugins/api-testing.ts")] } }, include: [join(dir, "**/*.ts"), join(APP_ROOT, "src/md.d.ts")] }));
      const result = await run([process.execPath.endsWith("bun") ? process.execPath : Bun.which("bun") ?? process.execPath, tsc, "-p", config], dir, { ...process.env, ORCA2_HOME: home });
      if (result.code === 0) out("ok   types\n"); else fail(`types:\n${result.out}`);
    } else out("skip types (no TypeScript next to this orca2)\n");
    const tests = (await readdir(dir, { recursive: true })).filter(file => String(file).endsWith(".test.ts") && !String(file).includes("node_modules"));
    const bun = process.execPath.endsWith("bun") ? process.execPath : Bun.which("bun");
    const preload = join(APP_ROOT, "src/core/plugins/preload.ts");
    if (tests.length > 0 && bun === null) out("skip tests (bun is not on PATH)\n");
    else if (tests.length > 0 && !existsSync(preload)) out("skip tests (no orca2 source next to this orca2)\n");
    else if (tests.length > 0 && bun !== null) {
      const result = await run([bun, "test", "--preload", preload, ...tests.map(file => `./${String(file)}`)], dir, { ...process.env, ORCA2_HOME: home });
      if (result.code === 0) out(`ok   tests (${tests.length} file${tests.length === 1 ? "" : "s"})\n`); else fail(`tests:\n${result.out}`);
    } else out("note no tests (add <name>.test.ts beside index.ts)\n");
  } finally {
    if (previous === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
  out(failures === 0 ? `${name}: all checks passed\n` : `${name}: ${failures} check${failures === 1 ? "" : "s"} failed\n`);
  return failures === 0 ? 0 : 1;
}

type Scope = { bubble: Bubble | null; directory: string };

async function pluginScope(args: string[], readOnly: boolean): Promise<Result<Scope>> {
  const cwd = process.cwd(),
    at = args.indexOf("--bubble"),
    global = args.includes("--global");
  if (at >= 0 && global) return fail("choose one scope: --global or --bubble [id]");
  if (global || (at < 0 && process.env.ORCA_CONVERSATION === undefined)) return ok({ bubble: null, directory: cwd });
  const given = at < 0 ? undefined : args[at + 1];
  if (given !== undefined && !given.startsWith("--")) {
    const bubble = await readBubble(given);
    return bubble === null ? fail(`unknown bubble ${given}`) : ok({ bubble, directory: bubble.directory ?? cwd });
  }
  const current = process.env.ORCA_CONVERSATION;
  const matches = current === undefined ? (await listConversations()).filter((c) => c.directory === cwd) : [];
  if (current === undefined && new Set(matches.map((c) => c.bubble ?? c.id)).size > 1)
    return fail("multiple bubbles or chats use this directory; pass --bubble <id> from orca2 bubbles");
  const conversation =
    current === undefined ? (matches[0] ?? (readOnly ? null : await conversationFor(cwd))) : await readConversation(current);
  if (current === undefined && conversation === null && readOnly) return ok({ bubble: null, directory: cwd });
  if (conversation === null) return fail(`unknown conversation ${current}`);
  if (readOnly) {
    const bubble = conversation.bubble === null ? null : await readBubble(conversation.bubble);
    return ok({ bubble, directory: conversation.directory });
  }
  const bubble = await ensureBubble(conversation.id);
  return bubble.ok ? ok({ bubble: bubble.data, directory: conversation.directory }) : bubble;
}

const namesInText = new Intl.ListFormat("en", { type: "conjunction" });
const RESTART = "New agents load this now; a running chat keeps the plugin code, watchers and tabs it loaded until you /stop it (or orca2 stop --conversation <id>) and reopen orca2.\n";

async function switches(names: string[], scope: Scope, state: "on" | "off" | null, out: Out): Promise<number> {
  const list = namesInText.format(names);
  if (scope.bubble !== null) {
    const changed = await setBubblePlugin(scope.bubble.id, names, state);
    if (!changed.ok) { out(changed.error + "\n"); return 1; }
  } else {
    if (state === null) { out("inherit requires a bubble\n"); return 2; }
    const config = await loadConfig();
    const plugins = config.plugins.filter(name => !names.includes(name));
    if (state === "on") plugins.push(...names);
    await saveConfig({ plugins: plugins.sort() });
  }
  const where = scope.bubble === null ? "globally" : `for ${scope.bubble.name}`;
  const message = state === null ? `Restored global defaults for ${list} in ${scope.bubble?.name}.`
    : `${state === "on" ? "Enabled" : "Disabled"} ${list} ${where}.`;
  out(message + "\n" + RESTART);
  return 0;
}

type LocalPlugin = { name: string; source: string; dest: string; copy: boolean; hash: string };

async function pluginAt(name: string, folder: string): Promise<Result<LocalPlugin>> {
  const dest = join(paths.plugins, name);
  const source = await realpath(folder), installed = await realpath(dest).catch(() => dest);
  const copy = source !== installed;
  if (copy && (source.startsWith(installed + sep) || installed.startsWith(source + sep))) {
    return fail("source and installed plugin folders overlap");
  }
  return ok({ name, source, dest, copy, hash: await pluginHash(source) });
}

async function localPlugin(name: string, from: string | null, scope: Scope): Promise<Result<LocalPlugin | null>> {
  if (builtinPlugins().some(p => p.name === name)) {
    return from === null ? ok(null) : fail(`${name} is supplied by Orca; choose another name for a custom plugin`);
  }
  const folder = from === null ? join(paths.plugins, name) : resolve(from);
  if (!existsSync(join(folder, "index.ts"))) {
    const repo = join(scope.directory, ".orca2", "plugins", name, "index.ts");
    if (from === null && existsSync(repo) && await trustState(scope.directory) === "trusted") {
      return scope.bubble === null ? fail("use --bubble to enable a repository plugin for its conversation") : ok(null);
    }
    return fail(`no plugin ${name} at ${folder}`);
  }
  return pluginAt(name, folder);
}

async function validateAndInstall(plugin: LocalPlugin): Promise<Result<null>> {
  let staging: string | null = null;
  try {
    let checked = plugin.source;
    if (plugin.copy) {
      await mkdir(paths.plugins, { recursive: true });
      staging = await mkdtemp(join(paths.plugins, ".install-"));
      checked = join(staging, plugin.name);
      await cp(plugin.source, checked, { recursive: true, filter: path => basename(path) !== "node_modules" });
    }
    if (await pluginHash(checked) !== plugin.hash) return fail(`${plugin.name} changed during approval; retry`);
    const loaded = await loadForCheck(checked, plugin.name);
    if (!loaded.ok) return loaded;
    const description = await describePlugin(loaded.data);
    if (!description.ok) return description;
    if (staging !== null) {
      const backup = join(staging, "previous"), replaced = existsSync(plugin.dest);
      if (replaced) await rename(plugin.dest, backup);
      try { await rename(checked, plugin.dest); }
      catch (error) { if (replaced) await rename(backup, plugin.dest); throw error; }
    }
    return ok(null);
  } finally { if (staging !== null) await rm(staging, { recursive: true, force: true }); }
}

type Confirm = { from: string | null; yes: boolean; out: Out; ask: Ask; interactive: boolean };

async function installAndApprove(locals: LocalPlugin[], confirm: Confirm): Promise<number | null> {
  const config = await loadConfig();
  const pending = locals.filter(p => !config.approved.includes(`${p.name}@${p.hash}`));
  if (pending.length > 0 && !confirm.yes) {
    const list = namesInText.format(pending.map(p => p.name));
    if (!confirm.interactive) { confirm.out(`Approval needed for ${list}. Use --yes to approve.\n`); return 3; }
    const origin = confirm.from === null ? "" : ` from ${confirm.from}`;
    if (!await confirm.ask(`Allow ${list}${origin} to run with your permissions?`)) {
      confirm.out("Cancelled.\n"); return 1;
    }
  }
  for (const plugin of locals) {
    const checked = await validateAndInstall(plugin);
    if (!checked.ok) { confirm.out(checked.error + "\n"); return 1; }
  }
  if (pending.length > 0) {
    const approved = config.approved.filter(pin => !pending.some(p => pin.startsWith(p.name + "@")));
    await saveConfig({ approved: [...approved, ...pending.map(p => `${p.name}@${p.hash}`)] });
  }
  return null;
}

function fromFolder(names: string[], flags: string[], out: Out): string | null | false {
  const from = option(flags, "--from");
  if (flags.includes("--from") && (names.length !== 1 || from === null || from.startsWith("--"))) {
    out("--from requires one plugin name and one folder\n"); return false;
  }
  return from;
}

async function enable(names: string[], flags: string[], scope: Scope, out: Out, ask: Ask, interactive: boolean): Promise<number> {
  const from = fromFolder(names, flags, out);
  if (from === false) return 2;
  const locals: LocalPlugin[] = [];
  for (const name of names) {
    const plugin = await localPlugin(name, from, scope);
    if (!plugin.ok) { out(plugin.error + "\n"); return 1; }
    if (plugin.data !== null) locals.push(plugin.data);
  }
  const installed = await installAndApprove(locals, { from, yes: flags.includes("--yes"), out, ask, interactive });
  return installed ?? switches(names, scope, "on", out);
}

async function update(names: string[], flags: string[], out: Out, ask: Ask, interactive: boolean): Promise<number> {
  const from = fromFolder(names, flags, out);
  if (from === false) return 2;
  const locals: LocalPlugin[] = [];
  const current: string[] = [];
  const config = await loadConfig();
  for (const name of names) {
    if (builtinPlugins().some(p => p.name === name)) { out(`${name} is supplied by Orca and updates with orca2\n`); return 1; }
    const dest = join(paths.plugins, name);
    if (!existsSync(join(dest, "index.ts"))) {
      out(`${name} is not an installed plugin; install it with orca2 plugin enable ${name} --from <folder>\n`); return 1;
    }
    const folder = from === null ? dest : resolve(from);
    if (!existsSync(join(folder, "index.ts"))) { out(`no plugin ${name} at ${folder}\n`); return 1; }
    const plugin = await pluginAt(name, folder);
    if (!plugin.ok) { out(plugin.error + "\n"); return 1; }
    const fresh = config.approved.includes(`${name}@${plugin.data.hash}`) && (!plugin.data.copy || await pluginHash(dest) === plugin.data.hash);
    if (fresh) current.push(name); else locals.push(plugin.data);
  }
  const installed = await installAndApprove(locals, { from, yes: flags.includes("--yes"), out, ask, interactive });
  if (installed !== null) return installed;
  for (const name of current) out(`${name} is up to date\n`);
  if (locals.length > 0) out(`Updated ${namesInText.format(locals.map(p => p.name))}.\n${RESTART}`);
  return 0;
}

export const PLUGIN_USAGE = `orca2 plugin list [--bubble [id] | --global] [--json]
  orca2 plugin show <name> [--bubble [id] | --global] [--json]
  orca2 plugin config <name> [--set <key> <JSON> | --unset <key>] [--bubble [id] | --global]
  orca2 plugin new <name> [--dir <folder>]
  orca2 plugin check <name|folder>
  orca2 plugin enable <name> [name ...] [--from <folder>] [--bubble [id] | --global] [--yes]
  orca2 plugin update <name> [name ...] [--from <folder>] [--yes]
  orca2 plugin disable <name> [--bubble [id] | --global]
  orca2 plugin inherit <name> --bubble [id]
  Inside an agent, the default scope is the current conversation's bubble. --yes approves the installed content for non-interactive use.
  After changing an installed plugin, update re-approves it (copying --from first) and keeps it on or off as it was.`;

export async function runPlugin(args: string[], out: Out, ask: Ask, interactive: boolean): Promise<number> {
  const [action = "list", ...rest] = args;
  if (action === "new") return newPlugin(rest, out);
  if (action === "check") return checkPlugin(rest, out);
  if (["help", "--help", "-h"].includes(action)) {
    out(PLUGIN_USAGE + "\n");
    return 0;
  }
  if (
    !["list", "show", "config", "enable", "update", "disable", "inherit"].includes(action) ||
    (action !== "list" && !NAME.test(rest[0] ?? ""))
  ) {
    out(PLUGIN_USAGE + "\n");
    return 2;
  }
  const firstFlag = rest.findIndex(arg => arg.startsWith("--"));
  const many = action === "enable" || action === "update";
  const count = many ? (firstFlag < 0 ? rest.length : firstFlag) : action === "list" ? 0 : 1;
  const targets = [...new Set(rest.slice(0, count))];
  if (many && !targets.every(name => NAME.test(name))) { out(PLUGIN_USAGE + "\n"); return 2; }
  const flags = rest.slice(count);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--bubble" && action !== "update") {
      const next = flags[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
    } else if (action === "config" && (flag === "--set" || flag === "--unset")) {
      const count = flag === "--set" ? 2 : 1;
      if (
        flags.length <= i + count ||
        (flags[i + 1] ?? "").startsWith("--") ||
        flags.slice(i + count + 1).some((f) => f === "--set" || f === "--unset")
      ) {
        out(PLUGIN_USAGE + "\n");
        return 2;
      }
      i += count;
    } else if (flag === "--from" && many) i++;
    else if (!(
      (flag === "--global" && action !== "update") ||
      (flag === "--yes" && many) ||
      (flag === "--json" && (action === "list" || action === "show"))
    )) {
      out(PLUGIN_USAGE + "\n");
      return 2;
    }
  }
  if (action === "update") return withStorageLock(join(paths.runtime, "plugin-config-lock"), () => update(targets, flags, out, ask, interactive));
  const scope = await pluginScope(
    rest,
    action === "list" || action === "show" || (action === "config" && !rest.includes("--set") && !rest.includes("--unset")),
  );
  if (!scope.ok) {
    out(scope.error + "\n");
    return 2;
  }
  const name = rest[0] ?? "";
  if (action === "enable" || action === "disable" || action === "inherit") {
    return withStorageLock(join(paths.runtime, "plugin-config-lock"), async () =>
      action === "enable"
        ? enable(targets, flags, scope.data, out, ask, interactive)
        : switches([name], scope.data, action === "disable" ? "off" : null, out),
    );
  }
  const { bubble, directory } = scope.data;
  if (action === "config") {
    const present =
      builtinPlugins().some((p) => p.name === name) ||
      existsSync(join(paths.plugins, name, "index.ts")) ||
      ((await trustState(directory)) === "trusted" && existsSync(join(directory, ".orca2", "plugins", name, "index.ts")));
    if (!present) {
      out(`no plugin ${name}\n`);
      return 1;
    }
    const set = rest.indexOf("--set"),
      unset = rest.indexOf("--unset"),
      id = bubble?.id ?? null;
    const settings =
      set < 0 && unset < 0
        ? await pluginSettings(name, id)
        : await withStorageLock(join(paths.runtime, "plugin-config-lock"), () =>
            setPluginSetting(
              name,
              id,
              rest[(set < 0 ? unset : set) + 1] ?? "",
              set < 0 ? null : parseJson(rest[set + 2] ?? ""),
            ),
          );
    if (!settings.ok) {
      out(settings.error + "\n");
      return 1;
    }
    out(JSON.stringify(settings.data) + "\n");
    return 0;
  }
  const config = await loadConfig();
  const { plugins, problems } = await availablePlugins(directory, (await trustState(directory)) === "trusted");
  const names = [...new Set([...plugins.keys(), ...problems.map((p) => p.name)])]
    .sort()
    .filter((n) => action === "list" || n === name);
  if (names.length === 0 && action === "show") {
    out(`no plugin ${name}\n`);
    return 1;
  }
  const rows = names.map((n) => {
    const loaded = plugins.get(n),
      problem = problems.find((p) => p.name === n);
    const override = bubble?.plugins.on.includes(n) === true ? "on" : bubble?.plugins.off.includes(n) === true ? "off" : null;
    return {
      name: n,
      enabled: loaded !== undefined && (override === null ? config.plugins.includes(n) : override === "on"),
      override,
      source: loaded?.source ?? null,
      directory: loaded?.dir ?? problem?.dir ?? null,
      description: loaded?.plugin.description ?? "",
      problem: problem?.problem ?? null,
    };
  });
  if (rest.includes("--json")) {
    out(JSON.stringify({ scope: bubble?.id ?? "global", plugins: rows }) + "\n");
    return 0;
  }
  for (const r of rows) out(`${r.enabled ? "on " : "off"} ${r.name.padEnd(14)} ${r.problem ?? r.description}\n`);
  const loaded = plugins.get(name);
  if (action === "show" && loaded !== undefined) {
    const details = await describePlugin(loaded);
    if (!details.ok) {
      out(details.error + "\n");
      return 1;
    }
    out(details.data.join("\n") + "\n");
  }
  return 0;
}
