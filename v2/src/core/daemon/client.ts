// The client side of a conversation's daemon (TUI, `orca2 msg`): start it when none runs, send input, ask it to
// cancel, compact or stop. Nothing here runs a turn or writes the orchestrator's transcript.
import { pidAlive } from "../lock";
import { readConversation } from "../conversations";
import { put, withdraw } from "../inbox";
import { launch, selectedRunner } from "../runner/runtime";
import { newRun, readRun, writeRun } from "../runner/runs";
import type { Delivery, Message } from "../types";
import { daemonPid, readStatus, request } from "./channel";

export const STOP_WAIT_MS = 10_000;

/** Start the conversation's daemon unless one is alive; returns its pid. */
export async function ensureDaemon(conversation: string, model: string | null): Promise<number> {
  const running = await daemonPid(conversation);
  if (running !== null) return running;
  const meta = await readConversation(conversation);
  if (meta === null) throw new Error(`no conversation ${conversation}`);
  const record = newRun({ conversation, agent: "orchestrator", role: "orchestrator", bundle: "orchestrator", branch: "", runner: (await selectedRunner(conversation)).name });
  await writeRun(record);
  await launch(record, meta.directory, model === null ? [] : ["--model", model], "daemon");
  for (let i = 0; i < 50; i++) {
    const pid = await daemonPid(conversation);
    if (pid !== null) return pid;
    const run = await readRun(conversation, "orchestrator");
    if (run !== null && run.pid !== null && !pidAlive(run.pid) && i > 5) break;
    await Bun.sleep(100);
  }
  throw new Error(`the daemon did not start; see ${record.log}`);
}

export async function say(conversation: string, text: string, images: string[], delivery: Delivery): Promise<Message> {
  return put(conversation, "orchestrator", "user", text, { images, delivery });
}

/** Take back queued input the orchestrator has not read yet. */
export async function unsay(conversation: string, id: string): Promise<Message | null> {
  return withdraw(conversation, "orchestrator", id);
}

export async function cancel(conversation: string): Promise<void> { await request(conversation, "cancel"); }
export async function compactNow(conversation: string): Promise<void> { await request(conversation, "compact"); }

export async function stopDaemon(conversation: string): Promise<void> {
  const pid = await daemonPid(conversation);
  if (pid === null) return;
  await request(conversation, "stop");
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await Bun.sleep(100);
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

export async function busy(conversation: string): Promise<boolean> {
  const status = await readStatus(conversation);
  return status !== null && status.state === "turn" && pidAlive(status.pid);
}
