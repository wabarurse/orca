import { killGroup } from "../../proc";
import { loadConfig } from "../../../config";
import { outputArtifact, OutputPreview } from "./output";
import type { Tool } from "../registry";
import { launchProcess } from "../../data/processes";
import { execution } from "../../data/projects/lifecycle";
import { cliCommand, sessionId } from "../../tmux";
import { shellCommand } from "../../execution";

const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// A model nudge, not a security boundary. Shell commands retain the user's privileges.
const SUDO = /\bsudo\b/;

/** Legacy helper retained for callers; the streaming tool below also budgets its footer. */
export function truncateMiddle(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${bytes.subarray(0, half).toString()}\n...[truncated ${bytes.length - half * 2} bytes]...\n${bytes.subarray(-half).toString()}`;
}

export const bash: Tool = {
  parallel: input => input.independent === true,
  spec: {
    name: "bash",
    description: "Run a non-interactive shell command in the working directory, inheriting the harness PATH. No sudo. Set timeout_ms to 10000–30000 for short checks that may stall (a database or service connection), and use the client's own timeouts. For looking things up on the web use web_search, not curl; use curl only to fetch a specific, already-known URL. Full output is saved outside the repository; large results include a preview and path to inspect with shell tools. Normal-sized output is returned intact. Set max_output_bytes to adjust the preview (up to the configured cap). Issue independent read-only commands together with independent=true; never use it for edits, shared writes, or commands requiring another call's result. All other calls run in order.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean", description: "Return a supervised process handle immediately; completion is sent to your inbox." },
        yield_ms: { type: "integer", minimum: 0, maximum: 30000, description: "Return after this interval while the supervised command continues. Separate from timeout_ms." },
        ready_url: { type: "string", description: "Optional localhost HTTP readiness probe for a background service. A successful probe sends a ready event." },
        timeout_ms: { type: "integer", minimum: 0, maximum: MAX_TIMEOUT_MS, description: "Maximum command runtime; timeout kills the process group. Default 600000. Zero is allowed only for supervised background services that must be explicitly stopped." },
        independent: { type: "boolean", description: "This read-only command has no dependency or conflicting effects with other calls in this batch. Default false." },
        max_output_bytes: { type: "integer", minimum: 512, maximum: 65536, description: "Requested preview limit, bounded by the configured maximum. Default: preserve normal output, shorten oversized output to 4 KiB." },
      }, required: ["command"],
    },
  },
  async run(input, ctx) {
    const epoch = ctx.executionEpoch ?? execution.epoch(ctx.project);
    execution.assertActive(ctx.project, epoch);
    const command = String(input.command ?? "");
    if (SUDO.test(command)) return "refused: sudo is not allowed";
    const timeout = input.timeout_ms;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS || (timeout === 0 && input.background !== true && input.yield_ms === undefined))) throw new Error("timeout_ms must be 1–600000; zero requires a supervised background command");
    const timeoutMs = timeout ?? MAX_TIMEOUT_MS;
    const requested = input.max_output_bytes;
    if (requested !== undefined && (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 512 || requested > 65536)) throw new Error("max_output_bytes must be an integer from 512 to 65536");
    ctx.signal?.throwIfAborted();
    const config = await loadConfig();
    if (input.background === true || input.yield_ms !== undefined) {
      if (input.yield_ms !== undefined && (typeof input.yield_ms !== "number" || !Number.isSafeInteger(input.yield_ms) || input.yield_ms < 0 || input.yield_ms > 30000)) throw new Error("yield_ms must be 0–30000");
      const yieldMs = input.background === true ? 0 : Number(input.yield_ms);
      if (!Number.isSafeInteger(yieldMs) || yieldMs < 0 || yieldMs > 30000) throw new Error("yield_ms must be 0–30000");
      const readyUrl = input.ready_url === undefined ? undefined : new URL(String(input.ready_url));
      if (readyUrl && (!['http:', 'https:'].includes(readyUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(readyUrl.hostname))) throw new Error("ready_url must be a localhost HTTP URL");
      const at = new Date().toISOString();
      return JSON.stringify(await launchProcess({ id: crypto.randomUUID(), project: ctx.project, owner: sessionId(ctx.role, ctx.branch),
        role: ctx.role, branch: ctx.branch, run: ctx.run, call: ctx.callId, cwd: ctx.cwd, command,
        createdAt: at, updatedAt: at, state: "starting", timeoutMs: timeoutMs, maxBytes: config.maxToolOutputBytes,
        notify: true, events: [], ...(readyUrl ? { readyUrl: readyUrl.toString() } : {}) }, cliCommand(), yieldMs, ctx.signal, epoch));
    }
    const cap = Math.min(config.maxToolResultBytes, Number(requested ?? config.maxToolResultBytes));
    const preview = new OutputPreview(cap);
    const artifact = await outputArtifact(ctx.project);
    let complete = false, path = "", limited = false, code = 0, timedOut = false;
    try {
      if (Buffer.byteLength(artifact.partialPath) + 240 > cap) throw new Error("tool output path exceeds preview budget; increase max_output_bytes and maxToolResultBytes");
      ctx.signal?.throwIfAborted();
      execution.assertActive(ctx.project, epoch);
      const argv = await shellCommand(`exec 2>&1\n${command}`, ctx.cwd, ctx.role === "reviewer");
      execution.assertActive(ctx.project, epoch);
      const proc = Bun.spawn(argv, { cwd: ctx.cwd, detached: true, stdout: "pipe", stdin: "ignore" });
      const kill = () => killGroup(proc);
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      process.once("exit", kill);
      ctx.signal?.addEventListener("abort", kill, { once: true });
      if (ctx.signal?.aborted) kill();
      let finished = false;
      try {
        for await (const chunk of proc.stdout) {
          const allowed = Math.min(chunk.length, config.maxToolOutputBytes - preview.bytes);
          if (allowed) { await artifact.write(chunk.subarray(0, allowed)); preview.add(chunk.subarray(0, allowed)); }
          if (allowed < chunk.length) { limited = true; kill(); break; }
        }
        code = await proc.exited; finished = true;
        ctx.signal?.throwIfAborted();
        complete = !limited && !timedOut;
      } finally {
        if (!finished) kill();
        await proc.exited;
        clearTimeout(timer); ctx.signal?.removeEventListener("abort", kill); process.off("exit", kill);
      }
    } finally { path = await artifact.finish(complete); }
    let footer = limited ? "\n[output limit reached; command terminated; saved output is incomplete]" : timedOut ? `\n[timed out after ${timeoutMs / 1000}s; saved output is incomplete]` : "";
    if (code !== 0) footer += `\n[exit ${code}]`;
    const clipped = !preview.fits(cap, footer);
    if (clipped || !complete) footer += `\n[${complete ? "full" : "partial"} output: ${path}]`;
    const previewCap = requested === undefined && clipped ? Math.min(4096, cap) : cap;
    return preview.render(previewCap, footer);
  },
};
