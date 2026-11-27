import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { item, pluginContext, present, toolContext } from "orca2/plugin/testing";
import { z } from "zod";
import { defineEvent, defineService, linksFor, listen } from ".";
import { paths, saveConfig } from "../../config";
import { fakeProvider } from "../../test/fake-provider";
import { tempHome } from "../../test/home";
import background from "../../test/plugins/example/background";
import plugin from "../../test/plugins/example/index";
import ui from "../../test/plugins/example/ui";
import { ensureBubble, setBubblePlugin } from "../bubbles";
import { createConversation } from "../conversations";
import { pending } from "../inbox";
import { newRun, writeRun } from "../runner/runs";
import { bash } from "../tools/bash";
import type { Tool, ToolContext } from "../tools/registry";
import { assemble } from "./assemble";
import { backgroundContext } from "./context";
import { enabledNames } from "./enable";
import { availablePlugins, pluginHash, registerBuiltins } from "./loader";
import { noLinks } from "./testing";
import { definePlugin, noHooks, type Plugin } from "./types";

describe("loading and enabling plugins", () => {
  const home = tempHome("plugins");

  const shell = (name: string, extra: Partial<Plugin>): Plugin => definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], retention: [], provides: [], uses: [], emits: [], on: [], ui: null, background: null, ...extra });
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
      const worker = await assembled({ conversation: c.id, agent: "worker-x", bundle: "worker", branch: null, cwd: home.path(), directory: home.path(), trusted: false });
      expect(worker.tools.find(t => t.spec.name === "bash")?.spec).toBe(replacing.tools[0]?.tool.spec);
      expect(worker.tools.map(t => t.spec.name)).not.toContain("extra");
      expect(worker.system).toContain("[rep] use the new bash");
      expect(worker.system).toContain("Plugins on in this bubble (1; the user turns them on or off with Ctrl+P):\n\n- rep: rep");
      const orc = await assembled({ conversation: c.id, agent: "orchestrator", bundle: "orchestrator", branch: null, cwd: home.path(), directory: home.path(), trusted: false });
      expect(orc.tools.map(t => t.spec.name)).toContain("extra");
      expect(orc.tools.map(t => t.spec.name)).not.toContain("write");
      const scout = await assembled({ conversation: c.id, agent: "scout-y", bundle: "scout", branch: null, cwd: home.path(), directory: home.path(), trusted: false });
      expect(scout.plugins).toEqual([]);
      expect(scout.system).toBe("scout things");
    });

    test.each([
      ["a core tool name without replaces", "bad", { tools: [{ tool: tool("read"), roles: ["worker"], replaces: false }] }, "set replaces: true"],
      ["a plugin named after a reserved $ORCA_DATA folder", "global", {}, "reserved"],
      ["a plugin guard rule without a valid id", "badguard", { guard: [{ id: "Bad Id", group: "security", test: () => true, reason: "r", suggest: () => "s" }] }, "guard.0.id"],
    ] satisfies [string, string, Partial<Plugin>, string][])("%s fails validation", async (_case, name, extra, problem) => {
      const bad = shell(name, extra);
      registerBuiltins([{ name, dir: `/x/${name}`, index: async () => ({ default: bad }), ui: null, background: null }]);
      expect((await availablePlugins(null, false)).problems[0]?.problem).toContain(problem);
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

    test("a plugin's guard rule is assembled and enforced by bash beside the core table", async () => {
      const guarded = shell("guarded", { guard: [{ id: "no-make", group: "efficiency", test: call => call.command?.program === "make", reason: "this repo builds with bun", suggest: () => "bun run build" }] });
      registerBuiltins([{ name: "guarded", dir: "/x/guarded", index: async () => ({ default: guarded }), ui: null, background: null }]);
      await saveConfig({ plugins: ["guarded"] });
      const c = await createConversation(home.path(), "g");
      const worker = await assembled({ conversation: c.id, agent: "worker-g", bundle: "worker", cwd: home.path(), directory: home.path(), trusted: false, branch: null });
      expect(worker.guard.map(rule => rule.id)).toEqual(["no-make"]);
      const ctx: ToolContext = { conversation: c.id, agent: "worker-g", role: "worker", branch: null, cwd: home.path(), data: home.path(), trusted: false, pluginSkills: [], guard: worker.guard,
        callId: "call", signal: new AbortController().signal, model: "fake-model", provider: fakeProvider([]), settings: null,
        runtime: { spawn: async () => { throw new Error("no spawn"); }, agents: async () => [], stop: async () => "", show: async () => "", confirm: async () => false }, links: noLinks };
      await expect(bash.run({ command: "make all" }, ctx)).rejects.toMatchObject({ rule: "no-make", message: "refused (no-make): this repo builds with bun. Use: bun run build" });
      await expect(bash.run({ command: "sudo ls" }, ctx)).rejects.toMatchObject({ rule: "sudo" });
      expect(await bash.run({ command: "echo built" }, ctx)).toBe("built");
    });
  });
});

describe("a plugin's background context", () => {
  const home = tempHome("context");

  test("tell reaches a running agent, and the orchestrator when the agent is not running", async () => {
    const c = await createConversation(home.path(), "c");
    await writeRun({ ...newRun({ conversation: c.id, agent: "worker-a", role: "worker", bundle: "worker", branch: "a", runner: "plain" }), state: "running", pid: process.pid });
    const ctx = backgroundContext(c.id, "demo", home.path());
    await ctx.tell("worker-a", "for you");
    await ctx.tell("worker-gone", "lost?");
    expect((await pending(c.id, "worker-a")).map(i => i.message.text)).toEqual(["for you"]);
    expect((await pending(c.id, "orchestrator")).map(i => `${i.message.from}: ${i.message.text}`)).toEqual(["demo: (for worker-gone, which is not running) lost?"]);
    expect((await ctx.agents()).map(a => a.agent)).toEqual(["worker-a"]);
  });
});

describe("plugin links", () => {
  tempHome("links");
  const heard: string[] = [];
  const base = (name: string): Plugin => definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], retention: [],
    provides: [], uses: [], emits: [], on: [], ui: null, background: null });
  const sender = { ...base("sender"),
    provides: [defineService("echo", "returns its text", z.object({ text: z.string() }), async (input, ctx) => ({ ok: true, data: `${ctx.plugin} echoes ${input.text} for ${ctx.from}` }))],
    emits: [defineEvent("ping", "a ping", z.object({ n: z.number() }))] };
  const hearer = { ...base("hearer"), uses: ["sender"], on: [listen("sender/ping", z.object({ n: z.number() }), async (payload, ctx) => { heard.push(`${ctx.plugin} heard ${payload.n} from ${ctx.from}`); })] };
  const broken = { ...base("broken"), on: [listen("sender/ping", z.object({ n: z.number() }), async () => { throw new Error("listener bug"); })] };
  const builtin = (plugin: Plugin) => ({ name: plugin.name, dir: join(tmpdir(), plugin.name), index: async () => ({ default: plugin }), ui: null, background: null });

  test("plugins reach each other only through the core: services check their input, events reach every enabled listener, and nothing reaches a plugin that is off", async () => {
    registerBuiltins([builtin(sender), builtin(hearer), builtin(broken), builtin(base("off"))]);
    await saveConfig({ plugins: ["broken", "hearer", "sender"] });
    const chat = await createConversation(mkdtempSync(join(tmpdir(), "orca2-links-")), "chat");
    const fromHearer = linksFor(chat.id, "hearer"), fromSender = linksFor(chat.id, "sender");

    expect(await fromHearer.call("sender", "echo", { text: "hi" })).toEqual({ ok: true, data: "sender echoes hi for hearer" });
    const bad = await fromHearer.call("sender", "echo", { text: 4 });
    expect(bad.ok ? "" : bad.error).toContain("echo input");
    const missing = await fromHearer.call("sender", "nope", {});
    expect(missing.ok ? "" : missing.error).toBe("sender provides no service nope; it provides echo");
    const off = await fromHearer.call("off", "anything", {});
    expect(off.ok ? "" : off.error).toBe("plugin off is not on in this bubble");

    expect(await fromSender.emit("ping", { n: 1 })).toEqual({ ok: true, data: 1 });
    expect(heard).toEqual(["hearer heard 1 from sender"]);
    const undeclared = await fromHearer.emit("ping", { n: 2 });
    expect(undeclared.ok ? "" : undeclared.error).toBe("hearer does not declare the event ping");
    const wrong = await fromSender.emit("ping", { n: "x" });
    expect(wrong.ok).toBe(false);
    expect(heard.length).toBe(1);
    await saveConfig({ plugins: [] });
  });
});

describe("the example plugin end to end", () => {
  const home = mkdtempSync(join(tmpdir(), "orca2-example-"));

  test("pin, list and the tab, count and memory section agree", async () => {
    const conversation = await createConversation(home, "t");
    const tool = item(plugin.tools, 0).tool;
    const ctx = toolContext(conversation.id, home);
    expect(await tool.run({ action: "add", text: "ship on friday" }, ctx)).toBe("pinned p1");
    expect(await tool.run({ action: "list" }, ctx)).toBe("p1: ship on friday");
    const pctx = pluginContext(conversation.id, "example", home);
    expect((await item(ui.tabs, 0).rows(pctx)).map(r => r.name)).toEqual(["ship on friday"]);
    expect(await item(ui.counts, 0).count(pctx)).toBe(1);
    const bctx = backgroundContext(conversation.id, "example", home);
    expect(await present(background.memory, "memory").text(bctx)).toBe("- p1: ship on friday");
  });

  test("the beforeTool hook blocks an over-long pin", async () => {
    const hook = item(plugin.hooks.beforeTool, 0);
    const pctx = pluginContext("c", "example", home, { data: async () => ({ ok: true, data: home }) });
    const result = await hook({ name: "pin", input: { action: "add", text: "x".repeat(201) } }, pctx);
    expect(result.action).toBe("block");
  });

  test("the guard rule sends reads of the pins file to the pin tool", () => {
    const rule = plugin.guard[0];
    const command = { program: "cat", args: ["data/example/pins.json"], env: {}, wrappers: [], cwd: home, stdin: false, reads: [], before: [], after: [], inner: [] };
    expect(rule?.test({ tool: "bash", input: {}, command, root: home })).toBe(true);
    expect(rule?.test({ tool: "bash", input: {}, command: { ...command, program: "ls" }, root: home })).toBe(false);
  });
});
