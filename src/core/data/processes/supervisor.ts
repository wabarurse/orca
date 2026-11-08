import { appendFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { readVerification, verificationPaths } from "./verification-store";
import { execution } from "../projects/lifecycle";
import { join } from "node:path";
import { killGroup } from "../../proc";
import { completeProcess, type Completion } from "../../process-completion";
import { shellCommand } from "../../execution";
import { pidAlive, withStorageLock } from "../storage-lock";
import { addProcessEvent, liveProcess, processDirectory, readProcess, saveProcess, type ProcessRecord } from "./store";

let inputSequence = 0;

/** Codex's unified execution inspired yielding a handle and reading output later.
 * Orca additionally owns a durable event outbox and a separate supervisor process.
 * https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec */
export async function superviseProcess(project: string, id: string, executable: string[]): Promise<void> {
  const dir = processDirectory(project, id);
  await withStorageLock(join(dir, "supervisor.lock"), async () => {
    const p = await readProcess(project, id);
    const admitted = await Bun.file(join(dir, "execution-epoch")).text().catch(() => execution.epoch(project));
    if (p.state !== "starting") return; // Reentry must never repeat a command.
    p.supervisorPid = process.pid;
    await saveProcess(p);
    let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    let completion: Completion | undefined;
    const cancellation = new AbortController();
    let stopping: ProcessRecord["state"] | undefined, busy = false, bytes = 0;
    const stop = () => {
      if (stopping) return;
      stopping = "cancelled";
      cancellation.abort(new Error("command stopped"));
    };
    const onExit = () => { if (proc) killGroup(proc); };
    try {
      const cancelled = execution.stale(project, admitted) || await Bun.file(join(dir, "stop")).exists();
      if (cancelled) { p.state = "cancelled"; await addProcessEvent(p, p.state); return; }
      const session = p.verification ? await readVerification(project, p.verification) : undefined;
      if (session && (session.state !== "active" || execution.stale(project, session.epoch))) throw new Error("verification has ended");
      const writable = session ? [verificationPaths(project, session.id).evidence, ...(session.simulator ? [verificationPaths(project, session.id).devices] : [])] : [];
      const argv = p.prChecks ? [...executable, "watch-pr-checks", "--project", project, "--process", id]
        : await shellCommand(`exec 2>&1\n${p.command}`, p.cwd, false, writable, session ? join(p.cwd, ".orca-tmp") : undefined);
      if (execution.stale(project, admitted)) { p.state = "cancelled"; await addProcessEvent(p, p.state); return; }
      proc = Bun.spawn(argv, { cwd: p.cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.pid = proc.pid; p.state = "running";
      process.once("exit", onExit); process.once("SIGTERM", stop); process.once("SIGINT", stop);
      await saveProcess(p);
      monitor = setInterval(async () => {
        if (busy) return; busy = true;
        try {
          if (execution.stale(project, admitted) || await Bun.file(join(dir, "stop")).exists()) stop();
          for (const name of (await readdir(dir)).filter(n => /^input-[a-f0-9-]+\.txt$/.test(n)).sort()) {
            const path = join(dir, name), text = await Bun.file(path).text();
            proc!.stdin.write(text);
            let inputTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([Promise.resolve(proc!.stdin.flush()), new Promise<never>((_, reject) => {
                inputTimer = setTimeout(() => reject(new Error("stdin backpressure timeout")), 1000);
              })]);
            } finally { clearTimeout(inputTimer); }
            await unlink(path);
          }
          if (p.readyUrl && !p.readyAt && !stopping) {
            const response = await fetch(p.readyUrl, { signal: AbortSignal.timeout(750), redirect: "error" }).catch(() => undefined);
            if (response?.ok) { p.readyAt = new Date().toISOString(); await addProcessEvent(p, "ready"); }
            await response?.body?.cancel();
          }
        } catch (error) { p.reason = `process control failed: ${error instanceof Error ? error.message : String(error)}`; stopping = "failed"; cancellation.abort(new Error(p.reason)); }
        finally { busy = false; }
      }, 250);
      completion = await completeProcess(proc, { timeoutMs: p.timeoutMs, signal: cancellation.signal,
        ...(p.recording ? { gracefulStop: () => { process.kill(-proc!.pid, "SIGINT"); }, graceMs: 2000 } : {}),
        chunk: async data => {
          const allowed = Math.max(0, Math.min(data.length, p.maxBytes - bytes)); bytes += allowed;
          if (allowed) await appendFile(join(dir, "output.txt"), data.subarray(0, allowed), { mode: 0o600 });
          if (allowed < data.length) { p.reason = "output limit reached; saved output is incomplete"; stopping = "failed"; throw new Error(p.reason); }
        } });
      clearInterval(monitor);
      while (busy) await Bun.sleep(10);
      p.exitCode = completion.code ?? undefined;
      p.state = completion.cleanupIncomplete ? "unknown" : stopping ?? (completion.timedOut ? "timed_out" : completion.reason || completion.code !== 0 ? "failed" : "exited");
      p.reason = [p.reason, completion.reason, ...completion.cleanupErrors,
        completion.cleanupIncomplete ? `cleanup incomplete for process group ${proc.pid}; processes may still be running; command will not be replayed` : undefined].filter(Boolean).join("; ") || undefined;
      if (p.artifact && p.state === "exited" && (!await Bun.file(p.artifact).exists() || Bun.file(p.artifact).size === 0)) {
        p.state = "failed"; p.reason = "capture produced no evidence";
      }
    } catch (error) {
      p.state = "failed"; p.reason = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(monitor);
      process.off("exit", onExit); process.off("SIGTERM", stop); process.off("SIGINT", stop);
      if (proc && !completion) {
        const cleanup = await completeProcess(proc, { timeoutMs: 1, chunk: () => {} });
        if (cleanup.cleanupIncomplete) { p.state = "unknown"; p.reason = `${p.reason ?? "command failed"}; cleanup incomplete for process group ${proc.pid}: ${cleanup.cleanupErrors.join("; ") || cleanup.reason}`; }
      }
      while (busy) await Bun.sleep(10);
    }
    await addProcessEvent(p, p.state);
  });
}

export async function controlProcess(project: string, id: string, action: "stop" | "input", text?: string): Promise<void> {
  const p = await readProcess(project, id);
  if (!liveProcess(p)) throw new Error("process is already terminal; inspect its status");
  const dir = processDirectory(project, id);
  if (action === "stop") { await writeFile(join(dir, "stop"), "requested\n"); return; }
  if (!p.supervisorPid || !pidAlive(p.supervisorPid)) throw new Error("process has no live supervisor; inspect its status");
  if (typeof text !== "string" || Buffer.byteLength(text) > 64000) throw new Error("input must be a string under 64 KiB");
  const path = join(dir, `input-${Date.now().toString(16).padStart(12, "0")}-${(++inputSequence).toString(16).padStart(8, "0")}-${crypto.randomUUID()}.txt`), tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, path);
}
