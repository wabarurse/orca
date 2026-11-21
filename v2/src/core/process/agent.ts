import { put } from "../inbox";
import { callText, resultText } from "../toolview";
import { fileConfirm, runtimeFor } from "../runner/runtime";
import { readRun, updateRun } from "../runner/runs";
import { openSession } from "../session";
import { flushSpans, spanRecorder } from "../spans";
import type { AgentEvent } from "../types";
import { asRecord, errorMessage } from "../../config";

export type AgentArgs = { conversation: string; agent: string; run: string; bundle: string; branch: string; cwd: string; fresh: boolean };

export async function agentProcess(args: AgentArgs, out: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  const abort = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];
  for (const signal of signals) process.on(signal, () => { abort.abort(new Error(`killed by ${signal}`)); });
  let reported = false;
  let lastTool: string | null = null;
  const emit = (event: AgentEvent): void => {
    if (event.kind === "text") out(event.text);
    else if (event.kind === "notice") out(`\n${event.text}\n`);
    else if (event.kind === "tool_start") { out(`\n${callText(event.call)}\n`); lastTool = event.call.name; void updateRun(args.conversation, args.agent, { lastTool, state: "running" }).catch(() => {}); }
    else if (event.kind === "tool_end") {
      out(`${resultText(event.call.name, event.outcome)}\n`);
      const input = asRecord(event.call.input);
      if (event.call.name === "inbox" && event.outcome.ok && input?.to === "orchestrator") { reported = true; void updateRun(args.conversation, args.agent, { reported: true, state: "reported" }).catch(() => {}); }
    } else if (event.kind === "input") { reported = false; void updateRun(args.conversation, args.agent, { reported: false, state: "running" }).catch(() => {}); }
  };
  const record = await readRun(args.conversation, args.agent);
  if (record === null || record.run !== args.run) { out(`no run record ${args.run} for ${args.agent}\n`); return 70; }
  const launched = Date.parse(record.startedAt);
  spanRecorder(args.conversation, args.agent, emit).begin("spawn", args.agent, Number.isFinite(launched) ? launched : null, null).end({ runner: record.runner, bundle: record.bundle });
  await updateRun(args.conversation, args.agent, { state: "running", pid: process.pid });
  let status: "done" | "cancelled" | "failed" = "failed", error: string | null = null;
  try {
    const opened = await openSession({ conversation: args.conversation, agent: args.agent, bundle: args.bundle, branch: args.branch, cwd: args.cwd,
      fresh: args.fresh, requireInput: false, emit, signal: abort.signal, runtime: runtimeFor(args.conversation, args.agent, fileConfirm(args.conversation, args.agent, abort.signal)),
      compactRequested: () => false, model: null, keep: null, resolve: null });
    if (!opened.ok) error = opened.error;
    else {
      const result = await opened.data.run();
      status = result.status;
      error = result.error;
    }
  } catch (cause) { error = errorMessage(cause); }
  const endedAt = new Date().toISOString();
  const state = status === "cancelled" ? "stopped" : status === "failed" ? "failed" : reported ? "reported" : "exited";
  await updateRun(args.conversation, args.agent, { state, endedAt, error, lastTool });
  if (status === "failed") out(`\n${args.agent} failed: ${error ?? "unknown error"}\n`);
  await flushSpans();
  if (!reported && status !== "cancelled") {
    const why = status === "failed" ? `failed: ${error ?? "unknown error"}` : "finished without reporting";
    await put(args.conversation, "orchestrator", args.agent, `[agent-exit] ${args.agent} ${why} (last tool: ${lastTool ?? "none"}; log: ${record.log})`, { images: [], delivery: "steer" });
  }
  return status === "failed" ? 1 : 0;
}
