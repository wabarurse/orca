// Headless mode: `orca2 -p "task"` runs the orchestrator in this process until the work is done (its subagents
// finished, its inbox empty) and prints the final answer; `--json` prints every event as one JSON line instead.
import { mkdir } from "node:fs/promises";
import { paths } from "../config";
import { createConversation, readConversation, saveConversation } from "./conversations";
import { lockPath } from "./daemon/channel";
import { pending, put } from "./inbox";
import { tryStorageLock } from "./lock";
import type { RollingCompactor } from "./loop/rolling";
import { runtimeFor } from "./runner/runtime";
import { listRuns, live, updateRun } from "./runner/runs";
import { openSession } from "./session";
import { openTranscript } from "./transcript";
import { trustForRun } from "./trust";
import type { AgentEvent } from "./types";

export type HeadlessOptions = {
  prompt: string;
  json: boolean;
  /** null uses the config's model. */
  model: string | null;
  cwd: string;
  /** Continue this conversation; null starts a new one. */
  conversation: string | null;
  bundle: string;
  /** Answer yes to plugin hooks that ask (there is nobody to ask). */
  yes: boolean;
  trust: boolean;
  out: (text: string) => void;
};

const IDLE_POLL_MS = 500;

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  if (options.trust) trustForRun(options.cwd);
  const existing = options.conversation === null ? null : await readConversation(options.conversation);
  if (options.conversation !== null && existing === null) { options.out(`no conversation ${options.conversation}\n`); return 1; }
  const conversation = existing ?? await createConversation(options.cwd, "headless");
  if (options.model !== null && conversation.model !== options.model) await saveConversation({ ...conversation, model: options.model });
  await mkdir(paths.daemon(conversation.id), { recursive: true });
  const release = await tryStorageLock(lockPath(conversation.id), conversation.id);
  if (release === undefined) { options.out(`conversation ${conversation.id} is held by a running daemon\n`); return 70; }
  const abort = new AbortController();
  const stop = (): void => { abort.abort(new Error("interrupted")); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const started = Date.now();
  const emit = (event: AgentEvent): void => { if (options.json) options.out(JSON.stringify({ ...event, conversation: conversation.id, ms: Date.now() - started }) + "\n"); };
  const transcript = openTranscript(paths.transcript(conversation.id, "orchestrator"));
  let rolling: RollingCompactor | null = null;
  let answer = "", status: "done" | "cancelled" | "failed" = "done", error: string | null = null;
  try {
    const agent = options.bundle === "orchestrator" ? "orchestrator" : `${options.bundle}-headless`;
    await put(conversation.id, agent, "user", options.prompt, { images: [], delivery: "steer" });
    for (;;) {
      if ((await pending(conversation.id, agent)).length > 0) {
        const session = await openSession({ conversation: conversation.id, agent, bundle: options.bundle, branch: null, cwd: options.cwd, fresh: false, requireInput: true,
          emit, signal: abort.signal, runtime: runtimeFor(conversation.id, agent, async () => options.yes), compactRequested: () => false,
          model: options.model, keep: agent === "orchestrator" ? { transcript, rolling } : null });
        rolling = session.rolling;
        const result = await session.run();
        if (result.text.length > 0) answer = result.text;
        status = result.status;
        error = result.error;
        if (status !== "done") break;
        continue;
      }
      const runs = (await listRuns(conversation.id)).filter(run => run.agent !== "orchestrator");
      for (const run of runs) if ((run.state === "running" || run.state === "starting") && !live(run) && Date.now() - Date.parse(run.startedAt) > 30_000) {
        await updateRun(conversation.id, run.agent, { state: "exited", endedAt: new Date().toISOString() });
        await put(conversation.id, "orchestrator", run.agent, `[agent-exit] ${run.agent} stopped unexpectedly (log: ${run.log})`, { images: [], delivery: "steer" });
      }
      if (!runs.some(live) && (await pending(conversation.id, agent)).length === 0) break;
      if (abort.signal.aborted) { status = "cancelled"; break; }
      await Bun.sleep(IDLE_POLL_MS);
    }
  } catch (cause) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    rolling?.dispose();
    await release();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (options.json) emit({ kind: "end", status, error, text: answer });
  else options.out(answer.length > 0 ? `${answer}\n` : "");
  if (!options.json && error !== null) process.stderr.write(`orca2: ${error}\n`);
  return status === "done" ? 0 : status === "cancelled" ? 130 : 1;
}
