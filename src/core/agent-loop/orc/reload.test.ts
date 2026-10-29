import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonStatus } from "../../../protocol/daemon";
import { paths } from "../../../config/paths";
import { reloadRunningDaemons, type ReloadOptions } from "./reload";
import { requireCurrentDaemon } from "./build";
import { createClientOrchestrator, daemonKeeper } from "./client";

const prior = process.env.ORCA_HOME;
let home: string | undefined;
afterEach(() => { process.env.ORCA_HOME = prior; if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });
function fixture() {
  home = mkdtempSync(join(tmpdir(), "orca-reload-")); process.env.ORCA_HOME = home;
  for (const p of ["a", "b", "c"]) mkdirSync(paths.project(p), { recursive: true });
  const old = (pid: number): DaemonStatus => ({ pid, run: `old-${pid}`, build: "old", state: "turn", since: "", turns: 1 });
  const states = new Map<string, DaemonStatus>([["a", old(100)], ["b", old(200)], ["c", { ...old(300), build: "new" }]]);
  const lives = new Set([100, 200, 300]), events: string[] = [];
  let tick = 0;
  const options: ReloadOptions = {
    build: "new", projects: async () => ["a", "b", "c", "closed"], status: async p => states.get(p),
    pid: async p => { const s = states.get(p); return s && lives.has(s.pid) ? s.pid : undefined; },
    alive: pid => lives.has(pid), identity: () => "same-project", now: () => tick, waitMs: 1000,
    stop: async (p, run) => { events.push(`stop:${p}:${run}`); },
    start: async p => { events.push(`start:${p}`); states.set(p, { ...old(400), build: "new", state: "idle" }); lives.add(400); },
    sleep: async () => { tick += 250; events.push("finish-current-turn"); lives.delete(100); lives.delete(200); },
    write: line => events.push(line),
  };
  return { options, events, states, lives };
}

test("global reload waits for each old process, never starts closed sessions, and skips current builds", async () => {
  const f = fixture();
  await reloadRunningDaemons(f.options);
  expect(f.events).toContain("stop:a:old-100"); expect(f.events).toContain("stop:b:old-200");
  expect(f.events).not.toContain("stop:c:old-300"); expect(f.events).not.toContain("start:closed");
  for (const p of ["a", "b"]) {
    expect(f.events.indexOf(`start:${p}`)).toBeGreaterThan(f.events.indexOf("finish-current-turn"));
    expect(f.states.get(p)?.build).toBe("new");
  }
});

test("a keeper winning the launch race is retained; replaced projects are never restarted", async () => {
  const f = fixture();
  f.options.projects = async () => ["a"];
  f.options.sleep = async () => { f.lives.delete(100); f.states.set("a", { ...f.states.get("a")!, pid: 500, run: "keeper", build: "new" }); f.lives.add(500); };
  await reloadRunningDaemons(f.options);
  expect(f.events).not.toContain("start:a");
  f.states.set("a", { ...f.states.get("a")!, build: "old" });
  let identity = "original";
  f.options.identity = () => identity;
  f.options.sleep = async () => { identity = "replacement"; f.lives.delete(500); };
  await reloadRunningDaemons(f.options);
  expect(f.events.some(e => e.includes("project replaced"))).toBe(true);
  expect(f.events).not.toContain("start:a");
});

test("an update wait never kills a running process or claims a failed launch succeeded", async () => {
  const f = fixture(); let now = 0;
  f.options.projects = async () => ["a"];
  f.options.now = () => now;
  f.options.sleep = async () => { now += 500; };
  await reloadRunningDaemons(f.options);
  expect(f.events.some(e => e.includes("no process was killed"))).toBe(true);
  expect(f.events).not.toContain("start:a"); expect(f.lives.has(100)).toBe(true);
});

test("a failed handoff retains its intent and a later reload restarts that session without a TUI", async () => {
  const f = fixture(); f.options.projects = async () => ["a", "closed"];
  f.options.sleep = async () => { f.lives.delete(100); f.states.delete("a"); throw new Error("helper interrupted"); };
  await reloadRunningDaemons(f.options);
  expect(f.events.some(e => e.includes("helper interrupted"))).toBe(true);
  expect(existsSync(join(paths.orchestrator("a"), "update.json"))).toBe(true);
  await reloadRunningDaemons(f.options);
  expect(f.events).toContain("start:a"); expect(f.events).not.toContain("start:closed");
  expect(f.states.get("a")?.build).toBe("new");
  expect(existsSync(join(paths.orchestrator("a"), "update.json"))).toBe(false);
});

test("replacement status can arrive after its process starts", async () => {
  const f = fixture(); f.options.projects = async () => ["a"];
  let starting = false;
  f.options.start = async () => { starting = true; f.states.delete("a"); };
  f.options.sleep = async () => {
    f.lives.delete(100);
    if (starting) f.states.set("a", { pid: 600, run: "replacement", build: "new", state: "idle", since: "", turns: 0 });
  };
  await reloadRunningDaemons(f.options);
  expect(f.events.some(e => e.includes("running new;"))).toBe(true);
  expect(f.events.some(e => e.includes("not applied"))).toBe(false);
});

test("a later pull during the turn uses the installed build at launch time", async () => {
  const f = fixture(); f.options.projects = async () => ["a"];
  let installed = "new";
  f.options.currentBuild = async () => installed;
  f.options.sleep = async () => { installed = "newer"; f.lives.delete(100); };
  f.options.start = async () => { f.states.set("a", { pid: 600, run: "replacement", build: installed, state: "idle", since: "", turns: 0 }); };
  await reloadRunningDaemons(f.options);
  expect(f.events.some(e => e.includes("running newer;"))).toBe(true);
  expect(f.events.some(e => e.includes("not applied"))).toBe(false);
});

test("a concurrent reload queues behind the active handoff and still applies its newer build", async () => {
  const f = fixture(); f.options.projects = async () => ["a"];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.options.sleep = async () => { await gate; f.lives.delete(100); };
  const first = reloadRunningDaemons(f.options);
  while (!f.events.includes("stop:a:old-100")) await Bun.sleep(1);
  const second = reloadRunningDaemons({ ...f.options, build: "newer",
    sleep: async () => { f.lives.delete(400); },
    start: async () => { f.states.set("a", { pid: 600, run: "replacement", build: "newer", state: "idle", since: "", turns: 0 }); },
  });
  try {
    await Bun.sleep(10);
    expect(f.events.some(e => e.includes("queued behind it"))).toBe(true);
  } finally { release(); }
  await Promise.all([first, second]);
  expect(f.events).toContain("stop:a:old-400");
  expect(f.states.get("a")?.build).toBe("newer");
});

test("build mismatch blocks new messages and commands, without stopping the daemon or writing input", async () => {
  const f = fixture(); let sent = 0;
  await expect(requireCurrentDaemon("a", { build: "new", status: f.options.status })).rejects.toThrow("orca reload");
  const c = await createClientOrchestrator({ project: "a", build: "new", status: f.options.status,
    alive: async () => true, put: async (_project, _to, message) => { sent++; return { ...message, ts: new Date().toISOString() }; } });
  await expect(c.say("do work")).rejects.toThrow("different Orca build");
  await expect(c.compact!()).rejects.toThrow("different Orca build");
  expect(sent).toBe(0);
  const keeper = daemonKeeper({ build: "new", alive: async () => true, status: f.options.status });
  await expect(keeper("a")).rejects.toThrow("orca reload");
  f.states.set("a", { ...f.states.get("a")!, build: "new" });
  await c.say("do work"); expect(sent).toBe(1);
  c.dispose?.();
});
