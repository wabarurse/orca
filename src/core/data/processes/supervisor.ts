import { appendFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { execution } from "../projects/lifecycle";
import { join } from "node:path";
import { killGroup } from "../../proc";
import { shellCommand } from "../../execution";
import { pidAlive, withStorageLock } from "../storage-lock";
import { addProcessEvent, liveProcess, processDirectory, readProcess, saveProcess, type ProcessRecord } from "./store";

let inputSequence = 0;

/** Codex's unified execution inspired yielding a handle and reading output later.
 * Orca additionally owns a durable event outbox and a separate supervisor process.
 * https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec */
export async function superviseProcess(project: string, id: string): Promise<void> {
  const dir = processDirectory(project, id);
  await withStorageLock(join(dir, "supervisor.lock"), async () => {
    const p = await readProcess(project, id);
    const admitted = await Bun.file(join(dir, "execution-epoch")).text().catch(() => execution.epoch(project));
    if (p.state !== "starting") return; // Reentry must never repeat a command.
    p.supervisorPid = process.pid;
    await saveProcess(p);
    let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, monitor: ReturnType<typeof setInterval> | undefined;
    let stopping: ProcessRecord["state"] | undefined, busy = false, bytes = 0;
    const stop = () => { stopping ??= "cancelled"; if (proc) killGroup(proc); };
    const onExit = () => { if (proc) killGroup(proc); };
    try {
      const cancelled = execution.stale(project, admitted) || await Bun.file(join(dir, "stop")).exists();
      if (cancelled) { p.state = "cancelled"; await addProcessEvent(p, p.state); return; }
      const argv = await shellCommand(`exec 2>&1\n${p.command}`, p.cwd, p.role === "reviewer");
      if (execution.stale(project, admitted)) { p.state = "cancelled"; await addProcessEvent(p, p.state); return; }
      proc = Bun.spawn(argv, { cwd: p.cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.pid = proc.pid; p.state = "running";
      process.once("exit", onExit); process.once("SIGTERM", stop); process.once("SIGINT", stop);
      await saveProcess(p);
      if (p.timeoutMs) timer = setTimeout(() => { stopping = "timed_out"; killGroup(proc!); }, p.timeoutMs);
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
        } catch (error) { p.reason = `process control failed: ${error instanceof Error ? error.message : String(error)}`; stopping = "failed"; killGroup(proc!); }
        finally { busy = false; }
      }, 250);
      const capture = async (stream: ReadableStream<Uint8Array>) => {
        for await (const data of stream) {
          const allowed = Math.max(0, Math.min(data.length, p.maxBytes - bytes)); bytes += allowed;
          if (allowed) await appendFile(join(dir, "output.txt"), data.subarray(0, allowed), { mode: 0o600 });
          if (allowed < data.length) { p.reason = "output limit reached; saved output is incomplete"; stopping = "failed"; killGroup(proc!); break; }
        }
      };
      const [, , code] = await Promise.all([capture(proc.stdout), capture(proc.stderr), proc.exited]);
      clearInterval(monitor);
      while (busy) await Bun.sleep(10);
      p.exitCode = code; p.state = stopping ?? (code === 0 ? "exited" : "failed");
    } catch (error) {
      p.state = "failed"; p.reason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer); clearInterval(monitor);
      process.off("exit", onExit); process.off("SIGTERM", stop); process.off("SIGINT", stop);
      if (proc) { killGroup(proc); await proc.exited; }
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
