import { killGroup } from "./process-signals";

interface Child {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): unknown;
  unref?(): void;
}
export interface Completion {
  code: number | null;
  reason?: string;
  timedOut: boolean;
  cleanupIncomplete: boolean;
  cleanupErrors: string[];
}

/** Exit and pipe EOF are independent. Neither failed signalling nor an inherited
 * pipe may extend a deadline. Cancellation closes our readers without awaiting
 * a child or stream implementation that refuses to finish. */
export async function completeProcess(child: Child, options: {
  timeoutMs: number; signal?: AbortSignal;
  chunk: (bytes: Uint8Array, stream: "stdout" | "stderr") => void | Promise<void>;
  kill?: () => string[];
  gracefulStop?: () => void;
  graceMs?: number;
  drainMs?: number;
}): Promise<Completion> {
  const result: Completion = { code: null, timedOut: false, cleanupIncomplete: false, cleanupErrors: [] };
  const readers = [child.stdout, child.stderr].filter((s): s is ReadableStream<Uint8Array> => !!s).map(s => s.getReader());
  let closed = false, stopping = false;
  let deadline: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined, settle: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  const forced = new Promise<void>(resolve => { release = resolve; });
  const kill = () => {
    try { result.cleanupErrors.push(...(options.kill?.() ?? killGroup(child))); }
    catch (error) { result.cleanupErrors.push(`process ${child.pid}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const terminate = (reason: string, timedOut = false, inheritedPipe = false) => {
    if (closed || stopping) return;
    stopping = true; result.reason = reason; result.timedOut = timedOut;
    result.cleanupIncomplete ||= inheritedPipe;
    const force = () => { kill(); settle = setTimeout(release, options.drainMs ?? 1000); };
    if (options.gracefulStop && !inheritedPipe) {
      try { options.gracefulStop(); grace = setTimeout(force, options.graceMs ?? 2000); }
      catch (error) { result.cleanupErrors.push(String(error)); force(); }
    } else force();
  };
  const abort = () => terminate(options.signal?.reason instanceof Error ? options.signal.reason.message : "command cancelled");
  const pumps = readers.map(async (reader, i) => {
    try {
      while (!closed) {
        const next = await reader.read();
        if (closed || next.done) break;
        await options.chunk(next.value, i === 0 ? "stdout" : "stderr");
      }
    } catch (error) {
      if (!closed) terminate(error instanceof Error ? error.message : String(error));
    }
  });
  const exited = child.exited.then(code => {
    if (closed) return;
    result.code = code;
    drain = setTimeout(() => terminate("output pipes remained open after command exit; descendants may still be running", false, true), options.drainMs ?? 1000);
  }, error => terminate(`could not observe command exit: ${String(error)}`));
  if (options.timeoutMs > 0) deadline = setTimeout(() => terminate(`timed out after ${options.timeoutMs / 1000}s`, true), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try { await Promise.race([Promise.all([...pumps, exited]), forced]); }
  finally {
    closed = true;
    clearTimeout(deadline); clearTimeout(drain); clearTimeout(grace); clearTimeout(settle);
    options.signal?.removeEventListener("abort", abort);
    // Mark closed before cancelling so a pending read cannot append after finalization.
    for (const reader of readers) void reader.cancel().catch(() => {});
    kill();
    result.cleanupErrors = [...new Set(result.cleanupErrors)];
    result.cleanupIncomplete ||= result.cleanupErrors.length > 0 || result.code === null;
    if (result.cleanupIncomplete) child.unref?.();
  }
  return result;
}
