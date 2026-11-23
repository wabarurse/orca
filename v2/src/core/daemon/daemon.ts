import { watch, type FSWatcher } from "node:fs";
import { archiveDue } from "../retention";
import { mkdir } from "node:fs/promises";
import { BUILD_ID, errorMessage, paths } from "../../config";
import { pluginData } from "../bubbles";
import { readConversation } from "../conversations";
import { consume, pending, put } from "../inbox";
import { tryStorageLock } from "../lock";
import type { RollingCompactor } from "../loop/rolling";
import { availablePlugins } from "../plugins/loader";
import { enabledNames } from "../plugins/enable";
import type { BackgroundContext, Watcher } from "../plugins/types";
import { backgroundContext } from "../plugins/context";
import { fileConfirm, runtimeFor, stopAgent } from "../runner/runtime";
import { listRuns, live, updateRun } from "../runner/runs";
import { openSession } from "../session";
import { openTranscript, type Transcript } from "../transcript";
import { trustState } from "../trust";
import { lockPath, takeCommands, writeStatus, type DaemonStatus } from "./channel";
import { liveWriter } from "./live";
import { runBackgroundHooks } from "../lifecycle";
import { flushSpans, phaseTracker, spanRecorder } from "../spans";

export const POLL_MS = 1000;
const WATCH_MS = 2000;
const ARCHIVE_MS = 3_600_000;

export type DaemonOptions = { conversation: string; run: string; exitWhenIdle: boolean; model: string | null; log: (text: string) => void };

type ScheduledWatcher = { watcher: Watcher; ctx: BackgroundContext; next: number; running: boolean };

async function backgroundWatchers(conversation: string, directory: string): Promise<ScheduledWatcher[]> {
  const trusted = await trustState(directory) === "trusted";
  const { plugins } = await availablePlugins(directory, trusted);
  const out: ScheduledWatcher[] = [];
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    if (loaded === undefined) continue;
    const loadedBackground = await loaded.background();
    const background = loadedBackground.ok ? loadedBackground.data : null;
    if (background === null) continue;
    const ctx = backgroundContext(conversation, name, directory);
    for (const watcher of background.watchers) out.push({ watcher, ctx, next: 0, running: false });
  }
  return out;
}

async function exitWatchdog(conversation: string): Promise<void> {
  for (const run of await listRuns(conversation)) {
    if (run.agent === "orchestrator" || (run.state !== "running" && run.state !== "starting") || run.pid === null || live(run)) continue;
    if (run.state === "starting" && Date.now() - Date.parse(run.startedAt) < 30_000) continue;
    await updateRun(conversation, run.agent, { state: "exited", endedAt: new Date().toISOString() });
    await put(conversation, "orchestrator", run.agent, `[agent-exit] ${run.agent} stopped unexpectedly (last tool: ${run.lastTool ?? "none"}; log: ${run.log})`, { images: [], delivery: "steer" });
  }
}

async function drainUser(conversation: string, transcript: Transcript, seen: Set<string>): Promise<void> {
  await consume(conversation, "user", seen, () => true, async messages => {
    await transcript.append({ type: "replies", messages: messages.map(m => ({ from: m.from, text: m.text })) });
  });
}

export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { conversation } = options;
  const meta = await readConversation(conversation);
  if (meta === null) { options.log(`no conversation ${conversation}\n`); return 1; }
  await mkdir(paths.daemon(conversation), { recursive: true, mode: 0o700 });
  const release = await tryStorageLock(lockPath(conversation), conversation);
  if (release === null) { options.log("another daemon holds this conversation\n"); return 70; }
  const transcript = openTranscript(paths.transcript(conversation, "orchestrator"));
  const userSeen = new Set<string>();
  let rolling: RollingCompactor | null = null;
  let status: DaemonStatus = { pid: process.pid, run: options.run, build: BUILD_ID, state: "idle", since: new Date().toISOString(), turns: 0, error: null, contextTokens: null, phase: null };
  const setStatus = async (patch: Partial<DaemonStatus>): Promise<void> => { status = { ...status, ...patch, since: new Date().toISOString() }; await writeStatus(conversation, status); };
  await setStatus({});
  await updateRun(conversation, "orchestrator", { state: "running", pid: process.pid });
  const watchers = await backgroundWatchers(conversation, meta.directory);
  const idle = phaseTracker(spanRecorder(conversation, "orchestrator", event => { if (event.kind === "notice") options.log(`${event.text}\n`); }));
  let compactRequested = false, stopping = false;
  let turnAbort: AbortController | null = null;
  const stopSignals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];
  for (const signal of stopSignals) process.on(signal, () => { stopping = true; turnAbort?.abort(new Error(`daemon ${signal}`)); });

  const handleCommands = async (): Promise<void> => {
    for (const command of await takeCommands(conversation)) {
      if (command.kind === "stop") stopping = true;
      if (command.kind === "compact") compactRequested = true;
      if (command.kind === "cancel") {
        turnAbort?.abort(new Error("cancelled by user"));
        for (const run of await listRuns(conversation)) if (run.agent !== "orchestrator" && live(run)) await stopAgent(conversation, run.agent);
      }
    }
  };
  let lastWatch = 0, lastArchive = 0, archiving = false;
  const maintenance = async (): Promise<void> => {
    if (Date.now() - lastWatch < WATCH_MS) return;
    lastWatch = Date.now();
    if (!archiving && Date.now() - lastArchive >= ARCHIVE_MS) {
      archiving = true;
      lastArchive = Date.now();
      void archiveDue(conversation, Date.now(), true).catch((error: unknown) => { options.log(`archive: ${String(error)}\n`); }).finally(() => { archiving = false; });
    }
    await exitWatchdog(conversation).catch((error: unknown) => { options.log(`watchdog: ${String(error)}\n`); });
    await drainUser(conversation, transcript, userSeen).catch(() => {});
    for (const item of watchers) {
      if (item.running || Date.now() < item.next) continue;
      item.running = true;
      void item.watcher.run(item.ctx).catch((error: unknown) => { options.log(`${item.ctx.plugin}/${item.watcher.name}: ${String(error)}\n`); })
        .finally(() => { item.running = false; item.next = Date.now() + item.watcher.everyMs; });
    }
  };

  let wake: (() => void) | null = null;
  const watchers_: FSWatcher[] = [];
  for (const dir of [paths.inbox(conversation, "orchestrator"), `${paths.daemon(conversation)}/commands`]) {
    await mkdir(dir, { recursive: true });
    try { watchers_.push(watch(dir, () => { wake?.(); })); } catch {}
  }

  try {
    while (!stopping) {
      await handleCommands();
      if (stopping) break;
      await maintenance();
      if ((await pending(conversation, "orchestrator")).length > 0 || compactRequested) {
        const turn = status.turns + 1;
        const writer = liveWriter(conversation, turn);
        turnAbort = new AbortController();
        const poll = setInterval(() => { void handleCommands().catch((error: unknown) => { options.log(`commands: ${String(error)}\n`); }); }, 100);
        idle.close();
        await setStatus({ state: "turn", turns: turn, error: null, phase: null });
        try {
          const manual = compactRequested;
          compactRequested = false;
          const opened = await openSession({ conversation, agent: "orchestrator", bundle: "orchestrator", branch: null, cwd: null, fresh: false, requireInput: !manual,
            emit: event => { writer.emit(event); if (event.kind === "text") options.log(event.text); }, signal: turnAbort.signal,
            runtime: runtimeFor(conversation, "orchestrator", fileConfirm(conversation, "orchestrator", turnAbort.signal)),
            compactRequested: () => manual, model: options.model, keep: { transcript, rolling }, resolve: null });
          if (!opened.ok) await setStatus({ error: opened.error });
          else {
            rolling = opened.data.rolling;
            const result = await opened.data.run();
            await setStatus({ error: result.error });
            if (result.error !== null) options.log(`\nturn failed: ${result.error}\n`);
          }
        } catch (error) {
          await setStatus({ error: errorMessage(error) });
        } finally {
          clearInterval(poll);
          turnAbort = null;
          await drainUser(conversation, transcript, userSeen).catch(() => {});
          await writer.end();
          await setStatus({ state: "idle" });
        }
        continue;
      }
      const runs = await listRuns(conversation);
      if (options.exitWhenIdle && runs.every(run => run.agent === "orchestrator" || !live(run))) break;
      const waiting = runs.filter(run => run.agent !== "orchestrator" && live(run)).map(run => run.agent);
      const before = idle.current();
      const phase = idle.observe(waiting.length > 0 ? "wait-worker" : "wait-inbox", waiting.length > 0 ? waiting.join(", ") : "input");
      if (before !== phase) { status = { ...status, phase }; await writeStatus(conversation, status); }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, POLL_MS); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    }
  } finally {
    for (const w of watchers_) w.close();
    idle.close();
    await flushSpans();
    rolling?.dispose();
    await runBackgroundHooks(conversation, "stop", options.log);
    await setStatus({ state: "stopped", phase: null });
    await updateRun(conversation, "orchestrator", { state: "stopped", endedAt: new Date().toISOString() });
    await release();
  }
  return 0;
}
