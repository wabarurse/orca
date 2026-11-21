import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, saveConfig } from "../../config";
import { tempHome } from "../../test/home";
import { ensureBubble, setBubblePlugin } from "../bubbles";
import { createConversation } from "../conversations";
import { assemble } from "./assemble";
import { enabledNames } from "./enable";
import { availablePlugins, pluginHash, registerBuiltins } from "./loader";
import { definePlugin, noHooks, type Plugin } from "./types";

const home = tempHome("plugins");

const shell = (name: string, extra: Partial<Plugin>): Plugin => definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], ui: null, background: null, ...extra });
const assembled = async (input: Parameters<typeof assemble>[0]) => {
  const result = await assemble(input);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const tool = (name: string) => ({ parallel: () => false, spec: { name, description: name, input_schema: { type: "object" as const, properties: {} } }, run: async () => name });

describe("plugins", () => {
  test("enablement: config defaults, then the bubble's on and off", async () => {
    registerBuiltins([]);
    const c = await createConversation(home.path(), "a");
    await saveConfig({ plugins: ["alpha", "beta"] });
    expect(await enabledNames(c.id)).toEqual(["alpha", "beta"]);
    const bubble = await ensureBubble(c.id);
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
});
