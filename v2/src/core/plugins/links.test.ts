import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { saveConfig } from "../../config";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { defineEvent, definePlugin, defineService, linksFor, listen, noHooks, registerBuiltins, type Plugin } from ".";

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
