import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../config";
import { tempHome } from "../../test/home";
import { createConversation } from "../conversations";
import { registerBuiltins } from "../plugins/loader";
import { defineBackground, definePlugin, noHooks, type Runner } from "../plugins/types";
import { launchCommand } from "./launch";
import { chooseRunner, runnerNames, runtimeFor, selectedRunner, stopAgents } from "./runtime";
import { newRun, readRun, updateRun, writeRun } from "./runs";

const home = tempHome("runtime");

const fakeRunner = (name: string): Runner => ({ name, start: async () => ({ handle: name, pid: null }), alive: async () => [], stop: async () => undefined, attach: async () => ({ ok: false, error: "fake" }) });

function register(names: string[]): void {
  registerBuiltins(names.map(name => ({
    name, dir: join(home.path(), name),
    index: async () => ({ default: definePlugin({ name, description: name, tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], guard: [], retention: [], provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" }) }),
    ui: null,
    background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner: fakeRunner(name), stop: null, remove: null }) }),
  })));
}

afterEach(() => { registerBuiltins([]); });

test("the core lists plain and every enabled runner plugin, saves the choice and falls back to plain", async () => {
  register(["tmux", "rex"]);
  await saveConfig({ plugins: ["tmux"], runner: "plain" });
  const c = await createConversation(home.path(), "mux");
  expect(await runnerNames(c.id)).toEqual(["plain", "tmux"]);
  expect(await chooseRunner(c.id, "rex")).toEqual({ ok: false, error: "unknown runner rex; choose plain, tmux" });
  expect((await loadConfig()).runner).toBe("plain");
  expect(await chooseRunner(c.id, "tmux")).toEqual({ ok: true, data: "tmux" });
  expect((await loadConfig()).runner).toBe("tmux");
  expect((await selectedRunner(c.id)).name).toBe("tmux");
  await saveConfig({ plugins: [] });
  expect(await runnerNames(c.id)).toEqual(["plain"]);
  expect((await selectedRunner(c.id)).name).toBe("plain");
});

test("the launch command keeps the environment out of argv in a private file that deletes itself", async () => {
  const log = join(home.path(), "agent.log");
  const command = await launchCommand({ conversation: "c", agent: "worker-a", argv: ["/bin/sh", "-c", 'echo "secret=$SECRET tmux=${TMUX:-unset}"'], cwd: home.path(), log,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SECRET: "hunter2 'quoted'", TMUX: "launcher" } });
  expect(command.argv.join(" ")).not.toContain("hunter2");
  const file = command.argv[4] ?? "";
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const proc = Bun.spawn(command.argv, { cwd: home.path(), env: {}, stdout: "pipe" });
  const shown = await new Response(proc.stdout).text();
  expect(shown).toBe("secret=hunter2 'quoted' tmux=unset\n");
  expect(readFileSync(log, "utf8")).toBe(shown);
  expect(existsSync(file)).toBe(false);
});

test("the orchestrator can start an agent in a named runner without /mux, is refused one that is off, and show opens its window", async () => {
  const opened: string[] = [];
  const box: Runner = { name: "box", start: async () => ({ handle: "box", pid: null }), alive: async () => [], stop: async () => undefined,
    attach: async (_c, label) => { opened.push(label); return { ok: true, data: { kind: "shown", note: `${label} is open beside orca2` } }; } };
  registerBuiltins([{ name: "box", dir: join(home.path(), "box"), ui: null,
    index: async () => ({ default: definePlugin({ name: "box", description: "box", tools: [], prompt: [], skills: [], storage: [], hooks: noHooks(), bundles: [], guard: [], retention: [],
      provides: [], uses: [], emits: [], on: [], ui: null, background: "./background.ts" }) }),
    background: async () => ({ default: defineBackground({ watchers: [], memory: null, runner: box, stop: null, remove: null }) }) }]);
  await saveConfig({ plugins: ["box"], runner: "plain" });
  const c = await createConversation(home.path(), "split");
  const runtime = runtimeFor(c.id, "orchestrator", async () => false);
  await expect(runtime.spawn({ bundle: "worker", branch: "x", brief: "look around", fresh: false, images: [], runner: "rex" })).rejects.toThrow("unknown runner rex; this bubble has plain, box");
  const info = await runtime.spawn({ bundle: "worker", branch: "x", brief: "look around", fresh: false, images: [], runner: "box" });
  expect(info.runner).toBe("box");
  expect((await loadConfig()).runner).toBe("plain");
  await updateRun(c.id, info.agent, { state: "running", pid: process.pid });
  expect((await readRun(c.id, info.agent))?.runner).toBe("box");
  expect(await runtime.show(info.agent)).toBe(`${info.agent} is open beside orca2`);
  expect(opened).toEqual([info.agent]);
  await saveConfig({ plugins: [] });
});

test("stopAgents stops every live subagent of a chat the way subagent stop does, and leaves the orchestrator and finished runs alone", async () => {
  const c = await createConversation(home.path(), "kill");
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const run = (agent: string, role: "orchestrator" | "worker", state: "running" | "exited", pid: number) =>
    ({ ...newRun({ conversation: c.id, agent, role, bundle: "worker", branch: agent, runner: "plain" }), state, pid, handle: String(pid) });
  await writeRun(run("worker-live", "worker", "running", child.pid));
  await writeRun(run("worker-done", "worker", "exited", child.pid));
  await writeRun(run("orchestrator", "orchestrator", "running", child.pid));
  expect(await stopAgents(c.id)).toEqual(["worker-live"]);
  expect((await readRun(c.id, "worker-live"))?.state).toBe("stopped");
  expect((await readRun(c.id, "worker-done"))?.state).toBe("exited");
  expect((await readRun(c.id, "orchestrator"))?.state).toBe("running");
  await child.exited;
});
