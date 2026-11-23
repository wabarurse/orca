import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../config";
import { createConversation } from "../../core/conversations";
import { defineBackground, definePlugin, noHooks, registerBuiltins, type Launch, type Runner } from "../../core/plugins";
import { item, pluginContext, present, recordingHost, toolContext } from "../../core/plugins/testing";
import { tempHome } from "../../test/home";
import plugin from "./index";
import ui from "./ui";

tempHome("proc-runner");
const tool = item(plugin.tools, 0).tool;
const tab = item(ui.tabs, 0);
const started: Launch[] = [], stopped: string[] = [], running = new Map<string, ReturnType<typeof Bun.spawn>>();
const boxRunner: Runner = {
  name: "box",
  start: async launch => { started.push(launch); running.set(launch.agent, Bun.spawn(launch.argv, { cwd: launch.cwd, stdout: "ignore", stderr: "ignore" })); return { handle: launch.agent, pid: null }; },
  alive: async () => [...running.entries()].filter(([, p]) => p.exitCode === null && p.signalCode === null).map(([label]) => label),
  stop: async (_conversation, label) => { stopped.push(label); running.get(label)?.kill(); },
  screen: async (_conversation, label) => ({ ok: true, data: [`screen of ${label}`] }),
  send: async () => ({ ok: true, data: null }),
};
const box = definePlugin({ name: "box", description: "a test runner", tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), guard: [], bundles: [], retention: [],
  provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" });

test("with another runner chosen, a background command runs in its window (labelled proc-<id>), its exit is still read, stop goes through the runner and Enter watches it", async () => {
  registerBuiltins([{ name: "box", dir: mkdtempSync(join(tmpdir(), "orca2-box-")), index: async () => ({ default: box }), ui: null,
    background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner: boxRunner, stop: null, remove: null }) }) }]);
  await saveConfig({ plugins: ["box", "processes"], runner: "box" });
  const chat = await createConversation(mkdtempSync(join(tmpdir(), "orca2-proc-runner-")), "t");
  const ctx = toolContext(chat.id, chat.directory, { agent: "worker-a", role: "worker", branch: "a" });
  const idOf = (text: string): string => present(/started (\w+)/.exec(text)?.[1], "process id");

  const quick = idOf(String(await tool.run({ action: "start", command: "echo from the window; exit 4" }, ctx)));
  expect(started.map(s => s.agent)).toEqual([`proc-${quick}`]);
  expect(item(started, 0).argv.join(" ")).toContain("tee");
  expect(String(await tool.run({ action: "wait", id: quick, timeout_seconds: 5 }, ctx))).toContain("exit 4");
  expect(String(await tool.run({ action: "output", id: quick }, ctx))).toContain("from the window");

  const slow = idOf(String(await tool.run({ action: "start", command: "sleep 30" }, ctx)));
  const pctx = pluginContext(chat.id, "processes", chat.directory);
  const rows = await tab.rows(pctx);
  expect(rows.find(r => r.id === slow)?.status).toBe("running");
  const { host, watched } = recordingHost(pctx, { pick: null, input: null, confirm: true });
  await present(tab.actions.find(a => a.key === "enter"), "watch").run(present(rows.find(r => r.id === slow), "row"), host);
  expect(watched.map(w => [w.runner, w.label])).toEqual([["box", `proc-${slow}`]]);
  expect(watched[0]?.log?.endsWith(`${slow}.log`)).toBe(true);
  expect(String(await tool.run({ action: "stop", id: slow }, ctx))).toContain(slow);
  expect(stopped).toEqual([`proc-${slow}`]);
  await saveConfig({ plugins: [], runner: "plain" });
});
