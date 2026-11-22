import { join } from "node:path";
import { BUILD_ID, paths } from "../../config";
import { listConversations } from "../conversations";
import { daemonPid, readStatus, request } from "../daemon/channel";
import { ensureDaemon } from "../daemon/client";
import { pidAlive, tryStorageLock } from "../lock";

export type ReloadOptions = {
  build: string;
  conversations: () => Promise<string[]>;
  start: (conversation: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  waitMs: number;
  startWaitMs: number;
  write: (message: string) => void;
};

const defaults = (): ReloadOptions => ({
  build: BUILD_ID,
  conversations: async () => (await listConversations()).map(c => c.id),
  start: conversation => ensureDaemon(conversation, null),
  sleep: ms => Bun.sleep(ms),
  now: Date.now,
  waitMs: 12 * 60 * 60 * 1000,
  startWaitMs: 10_000,
  write: message => { process.stdout.write(`${message}\n`); },
});

export async function reloadRunningDaemons(options: Partial<ReloadOptions> = {}): Promise<void> {
  const o = { ...defaults(), ...options };
  const lock = join(paths.runtime, "update-lock");
  let release = await tryStorageLock(lock, null);
  if (release === null) o.write("another update handoff is running; queued behind it");
  while (release === null) { await o.sleep(1000); release = await tryStorageLock(lock, null); }
  try {
    await Promise.all((await o.conversations()).map(async conversation => {
      const failure = await reloadOne(conversation, o);
      if (failure !== null) o.write(`${conversation}: update not applied: ${failure}`);
    }));
    o.write("update handoffs finished. Running workers finish on their loaded builds; newly started agents use the installed binary. Reopen open TUIs to update the interface.");
  } finally { await release(); }
}

async function reloadOne(conversation: string, o: ReloadOptions): Promise<string | null> {
  const pid = await daemonPid(conversation);
  const old = await readStatus(conversation);
  if (pid === null || old === null || old.state === "stopped" || old.build === o.build) return null;
  o.write(`${conversation}: ${old.build} → ${o.build}; waiting for the current turn to finish`);
  await request(conversation, "stop");
  const deadline = o.now() + o.waitMs;
  while (pidAlive(pid)) {
    if (o.now() >= deadline) return "still running after the update wait; no process was killed. Run orca2 pull again after it finishes";
    await o.sleep(250);
  }
  if (await daemonPid(conversation) === null) await o.start(conversation);
  const startedBy = o.now() + o.startWaitMs;
  let running = await readStatus(conversation);
  while ((running === null || running.state === "stopped" || running.run === old.run) && o.now() < startedBy) { await o.sleep(100); running = await readStatus(conversation); }
  if (running === null || running.state === "stopped" || running.build !== o.build) return `replacement build not confirmed (${running?.build ?? "not running"}); run orca2 pull again to retry`;
  o.write(`${conversation}: running ${running.build}; conversation and queued input retained`);
  return null;
}
