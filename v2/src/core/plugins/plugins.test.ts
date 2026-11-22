import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok, paths, saveConfig } from "../../config";
import { tempHome } from "../../test/home";
import { ensureBubble, setBubblePlugin } from "../bubbles";
import { createConversation } from "../conversations";
import { assemble } from "./assemble";
import { enabledNames } from "./enable";
import { availablePlugins, pluginHash, registerBuiltins } from "./loader";
import { beforeTool, type LoopHooks } from "../loop/hooks";
import type { Tool } from "../tools/registry";
import { definePlugin, noHooks, type BeforeTool, type Plugin, type PluginContext } from "./types";

const home = tempHome("plugins");

const shell = (name: string, extra: Partial<Plugin>): Plugin => definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], ui: null, background: null, ...extra });
const assembled = async (input: Parameters<typeof assemble>[0]) => {
  const result = await assemble(input);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const tool = (name: string): Tool => ({ parallel: () => false, spec: { name, description: name, input_schema: { type: "object", properties: {} } }, run: async () => name });

describe("plugins", () => {
  test("enablement: config defaults, then the bubble's on and off", async () => {
    registerBuiltins([]);
    const c = await createConversation(home.path(), "a");
    await saveConfig({ plugins: ["alpha", "beta"] });
    expect(await enabledNames(c.id)).toEqual(["alpha", "beta"]);
    const ensured = await ensureBubble(c.id);
    if (!ensured.ok) throw new Error(ensured.error);
    const bubble = ensured.data;
    await setBubblePlugin(bubble.id, "beta", "off");
    await setBubblePlugin(bubble.id, "gamma", "on");
    expect(await enabledNames(c.id)).toEqual(["alpha", "gamma"]);
  });

  test("assembly adds plugin tools by role, replaces a core tool only when asked, and adds prompts and bundles", async () => {
    const replacing = shell("rep", { tools: [{ tool: tool("bash"), roles: ["worker"], replaces: true }, { tool: tool("extra"), roles: ["orchestrator"], replaces: false }],
      prompt: [{ role: "worker", text: "use the new bash" }], bundles: [{ name: "scout", role: "worker", prompt: "scout things", plugins: [] }] });
    registerBuiltins([{ name: "rep", dir: "/x/rep", index: async () => ({ default: replacing }), ui: null, background: null }]);
    await saveConfig({ plugins: ["rep"] });
    const c = await createConversation(home.path(), "b");
    const worker = await assembled({ conversation: c.id, agent: "worker-x", bundle: "worker", cwd: home.path(), directory: home.path(), trusted: false });
    expect(worker.tools.find(t => t.spec.name === "bash")).toBe(replacing.tools[0]?.tool);
    expect(worker.tools.map(t => t.spec.name)).not.toContain("extra");
    expect(worker.system).toContain("[rep] use the new bash");
    const orc = await assembled({ conversation: c.id, agent: "orchestrator", bundle: "orchestrator", cwd: home.path(), directory: home.path(), trusted: false });
    expect(orc.tools.map(t => t.spec.name)).toContain("extra");
    expect(orc.tools.map(t => t.spec.name)).not.toContain("write");
    const scout = await assembled({ conversation: c.id, agent: "scout-y", bundle: "scout", cwd: home.path(), directory: home.path(), trusted: false });
    expect(scout.plugins).toEqual([]);
    expect(scout.system).toBe("scout things");
  });

  test("a core tool name without replaces fails validation", async () => {
    const bad = shell("bad", { tools: [{ tool: tool("read"), roles: ["worker"], replaces: false }] });
    registerBuiltins([{ name: "bad", dir: "/x/bad", index: async () => ({ default: bad }), ui: null, background: null }]);
    const { problems } = await availablePlugins(null, false);
    expect(problems[0]?.problem).toContain("set replaces: true");
  });

  test("a plugin named after a reserved $ORCA_DATA folder fails validation", async () => {
    registerBuiltins([{ name: "global", dir: "/x/global", index: async () => ({ default: shell("global", {}) }), ui: null, background: null }]);
    const { problems } = await availablePlugins(null, false);
    expect(problems[0]?.problem).toContain("reserved");
  });

  test("a user plugin loads only once this exact content is approved", async () => {
    registerBuiltins([]);
    const dir = join(paths.plugins, "mine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), `export default { name: "mine", description: "m", tools: [], prompt: [], skills: [], storage: [], hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] }, bundles: [], ui: null, background: null };\n`);
    expect((await availablePlugins(null, false)).problems[0]?.problem).toContain("not approved");
    await saveConfig({ approved: [`mine@${await pluginHash(dir)}`] });
    expect((await availablePlugins(null, false)).plugins.has("mine")).toBe(true);
    writeFileSync(join(dir, "index.ts"), `export default { name: "mine", description: "changed", tools: [], prompt: [], skills: [], storage: [], hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] }, bundles: [], ui: null, background: null };\n`);
    expect((await availablePlugins(null, false)).plugins.has("mine")).toBe(false);
  });

  test("a folder's own plugins load only when it is trusted", async () => {
    registerBuiltins([]);
    const repo = join(home.path(), "repo");
    mkdirSync(join(repo, ".orca2", "plugins", "local"), { recursive: true });
    writeFileSync(join(repo, ".orca2", "plugins", "local", "index.ts"), `export default { name: "local", description: "l", tools: [], prompt: [], skills: [], storage: [], hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] }, bundles: [], ui: null, background: null };\n`);
    expect((await availablePlugins(repo, false)).plugins.has("local")).toBe(false);
    expect((await availablePlugins(repo, true)).plugins.get("local")?.source).toBe("repo");
  });

  test("a plugin's guard rule is assembled and enforced beside the core table", async () => {
    const guarded = shell("guarded", { guard: [{ id: "no-make", group: "efficiency", test: call => call.command?.program === "make", reason: "this repo builds with bun", suggest: () => "bun run build" }] });
    registerBuiltins([{ name: "guarded", dir: "/x/guarded", index: async () => ({ default: guarded }), ui: null, background: null }]);
    await saveConfig({ plugins: ["guarded"] });
    const c = await createConversation(home.path(), "g");
    const worker = await assembled({ conversation: c.id, agent: "worker-g", bundle: "worker", cwd: home.path(), directory: home.path(), trusted: false });
    const no = async () => false;
    expect(await beforeTool(worker.hooks, "bash", { command: "make all" }, home.path(), no)).toEqual({ action: "block", reason: "refused (no-make): this repo builds with bun. Use: bun run build", refused: "no-make" });
    expect(await beforeTool(worker.hooks, "bash", { command: "sudo ls" }, home.path(), no)).toMatchObject({ action: "block", refused: "sudo" });
    expect(await beforeTool(worker.hooks, "bash", { command: "bun run build" }, home.path(), no)).toEqual({ action: "run", input: { command: "bun run build" } });
    const ctx: PluginContext = { plugin: "rewrite", conversation: c.id, agent: "worker-g", role: "worker", cwd: home.path(), data: async () => ok("") };
    const rewrite: BeforeTool = async () => ({ action: "run", input: { command: "sudo ls" } });
    const rewriting: LoopHooks = { ...worker.hooks, beforeTool: [{ ctx, hook: rewrite }] };
    expect(await beforeTool(rewriting, "bash", { command: "ls" }, home.path(), no)).toMatchObject({ action: "block", refused: "sudo" });
  });

  test("a plugin guard rule without a valid id fails validation", async () => {
    const bad = shell("badguard", { guard: [{ id: "Bad Id", group: "security", test: () => true, reason: "r", suggest: () => "s" }] });
    registerBuiltins([{ name: "badguard", dir: "/x/badguard", index: async () => ({ default: bad }), ui: null, background: null }]);
    expect((await availablePlugins(null, false)).problems[0]?.problem).toContain("guard.0.id");
  });
});
