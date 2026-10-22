import { killGroup } from "../cancellation";
import { loadConfig } from "../config";
import { outputArtifact, OutputPreview } from "../tool-output";
import type { Tool } from "./index";

const TIMEOUT_MS = 10 * 60 * 1000;
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
    description: "Run a shell command in the working directory. No sudo. Full output is saved outside the repository; large results include a preview and path to inspect with shell tools. Normal-sized output is returned intact. Set max_output_bytes to adjust the preview (up to the configured cap). Issue independent read-only commands together with independent=true; never use it for edits, shared writes, or commands requiring another call's result. All other calls run in order.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        independent: { type: "boolean", description: "This read-only command has no dependency or conflicting effects with other calls in this batch. Default false." },
        max_output_bytes: { type: "integer", minimum: 512, maximum: 65536, description: "Requested preview limit, bounded by the configured maximum. Default: preserve normal output, shorten oversized output to 4 KiB." },
      }, required: ["command"],
    },
  },
  async run(input, ctx) {
    const command = String(input.command ?? "");
    if (SUDO.test(command)) return "refused: sudo is not allowed";
    const requested = input.max_output_bytes;
    if (requested !== undefined && (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 512 || requested > 65536)) throw new Error("max_output_bytes must be an integer from 512 to 65536");
    ctx.signal?.throwIfAborted();
    const config = await loadConfig();
    const cap = Math.min(config.maxToolResultBytes, Number(requested ?? config.maxToolResultBytes));
    const preview = new OutputPreview(cap);
    const artifact = await outputArtifact(ctx.project);
    let complete = false, path = "", limited = false, code = 0, timedOut = false;
    try {
      if (Buffer.byteLength(artifact.partialPath) + 240 > cap) throw new Error("Tool output path exceeds preview budget; increase max_output_bytes and maxToolResultBytes");
      ctx.signal?.throwIfAborted();
      const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], { cwd: ctx.cwd, detached: true, stdout: "pipe", stdin: "ignore" });
      const kill = () => killGroup(proc);
      const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
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
    let footer = limited ? "\n[output limit reached; command terminated; saved output is incomplete]" : timedOut ? `\n[timed out after ${TIMEOUT_MS / 1000}s; saved output is incomplete]` : "";
    if (code !== 0) footer += `\n[exit ${code}]`;
    const clipped = !preview.fits(cap, footer);
    if (clipped || !complete) footer += `\n[${complete ? "full" : "partial"} output: ${path}]`;
    const previewCap = requested === undefined && clipped ? Math.min(4096, cap) : cap;
    return preview.render(previewCap, footer);
  },
};
