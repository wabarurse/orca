// Global update activation is separate from installation. Stop is deliberately
// queued (never cancel/kill): even older daemons process it only between turns.
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_ID, paths } from "../../../config";
import type { DaemonStatus } from "../../../protocol";
import { pidAlive, tryStorageLock } from "../../data";
import { projectIdentity } from "../../data/projects";
import { execution } from "../../data/projects/lifecycle";
import { cliCommand, delay } from "../../tmux";
import { command } from "../../proc";
import { daemonPid, liveStatus, request } from "./channel";
import { ensureDaemon } from "./client";

export interface ReloadOptions {
  build?: string;
  currentBuild?: () => Promise<string>;
  projects?: () => Promise<string[]>;
  status?: typeof liveStatus;
  pid?: typeof daemonPid;
  alive?: typeof pidAlive;
  identity?: typeof projectIdentity;
  stop?: (project: string, run: string) => Promise<unknown>;
  start?: (project: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  startWaitMs?: number;
  write?: (message: string) => void;
}

/** Runs in a detached installed-binary helper, so closing the updater/TUI cannot
 * interrupt the handoff. A single global lock prevents competing reload helpers.
 * No worker is stopped, no history is rewritten, no failed turn is replayed. */
export async function reloadRunningDaemons(options: ReloadOptions = {}): Promise<void> {
  const write = options.write ?? console.log;
  let release = await tryStorageLock(join(paths.runtime, "update-lock"));
  if (!release) write("another update handoff is running; queued behind it");
  // Do not drop a second update: some projects may already have restarted into
  // the previous build while the first helper waits for another project's turn.
  while (!release) { await delay(1000); release = await tryStorageLock(join(paths.runtime, "update-lock")); }
  const o = { build: BUILD_ID, status: liveStatus, pid: daemonPid, alive: pidAlive, identity: projectIdentity,
    stop: (project: string, run: string) => request(project, { kind: "stop" }, run),
    start: async (project: string) => ensureDaemon(project, { build: await installedBuild() }),
    currentBuild: options.build ? async () => options.build! : installedBuild,
    sleep: (ms: number) => delay(ms), now: Date.now, waitMs: 12 * 60 * 60 * 1000, startWaitMs: 10_000, ...options, write };
  try {
    o.build = await o.currentBuild();
    const projects = await (options.projects?.() ?? readdir(paths.projects).catch(() => []));
    await Promise.all(projects.filter(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)).map(async project => {
      try {
        if (execution.stopped(project)) { await clearIntent(project); return; }
        const saved = await readIntent(project);
        if (saved && saved.identity !== o.identity(project)) { await clearIntent(project); throw new Error("project replaced during update; not restarted"); }
        const current = await o.status(project);
        if (current?.build === o.build && current.state !== "stopped") { await clearIntent(project); return; }
        const old = current && current.state !== "stopped" ? current : saved?.old;
        if (!old) return; // Never start a closed session without a prior handoff.
        const identity = saved?.identity ?? o.identity(project);
        await saveIntent(project, { identity, old });
        await reloadOne(project, old, identity, o);
        await clearIntent(project);
      } catch (error) { write(`${project}: update not applied: ${error instanceof Error ? error.message : error}`); }
    }));
    write("update handoffs finished. Existing workers/reviewers finish on their loaded builds; newly launched agents use the installed binary. Reopen existing TUIs to update the interface.");
  } finally { await release(); }
}

type Settled = Required<Omit<ReloadOptions, "projects">>;
async function reloadOne(project: string, old: DaemonStatus, identity: string, o: Settled): Promise<void> {
  const deadline = o.now() + o.waitMs;
  // Recheck after discovery; a replacement daemon must not inherit the old stop.
  const current = await o.status(project);
  if (current && (current.run !== old.run || current.pid !== old.pid)) throw new Error("daemon changed during update; run orca reload again");
  o.write(`${project}: ${old.build ?? "unknown build"} → ${o.build}; waiting for the current turn to finish`);
  if (current && current.state !== "stopped") await o.stop(project, old.run);
  while (o.alive(old.pid)) {
    if (o.identity(project) !== identity) throw new Error("project replaced during update; reopen it manually");
    if (o.now() >= deadline) throw new Error("still running after the update wait; no process was killed. Run orca reload again after it finishes");
    await o.sleep(250);
  }
  if (o.identity(project) !== identity) throw new Error("project replaced during update; not restarted");
  // A TUI keeper may win the launch race. Its daemon lock remains authoritative.
  if (await o.pid(project) === undefined) await o.start(project);
  // The launch record precedes the first status write. Give a keeper's launch
  // the same startup grace, and verify against the executable now on disk (a
  // later pull may have replaced it while this helper waited for a long turn).
  const expected = await o.currentBuild(), startedBy = o.now() + o.startWaitMs;
  let running = await o.status(project);
  while ((!running || running.state === "stopped" || running.run === old.run) && o.now() < startedBy) {
    await o.sleep(100); running = await o.status(project);
  }
  if (!running || running.state === "stopped" || running.build !== expected) throw new Error(`replacement build not confirmed (${running?.build ?? "not running"}); run orca reload to retry`);
  o.write(`${project}: running ${running.build}; conversation and queued input retained`);
}

async function installedBuild(): Promise<string> {
  if (!Bun.isStandaloneExecutable) return BUILD_ID;
  const result = await command([...cliCommand(), "version"], paths.root);
  const build = /\(([^\n()]+)\)\s*$/.exec(result.out)?.[1];
  if (result.code !== 0 || !build) throw new Error("cannot identify the installed executable; run orca reload again after installation finishes");
  return build;
}

interface Intent { identity: string; old: DaemonStatus }
const intentPath = (project: string) => join(paths.orchestrator(project), "update.json");
async function readIntent(project: string): Promise<Intent | undefined> {
  try {
    const value = JSON.parse(await readFile(intentPath(project), "utf8")) as Intent;
    if (typeof value.identity !== "string" || typeof value.old?.run !== "string" || !Number.isInteger(value.old.pid)) throw new Error("invalid update recovery record");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
async function saveIntent(project: string, intent: Intent): Promise<void> {
  await mkdir(paths.orchestrator(project), { recursive: true, mode: 0o700 });
  const path = intentPath(project), tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(intent), { mode: 0o600 }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
const clearIntent = (project: string) => rm(intentPath(project), { force: true });
