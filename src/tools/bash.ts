import { killGroup } from "../cancellation";
import { loadConfig } from "../config";
import type { Tool } from "./index";

const TIMEOUT_MS = 10 * 60 * 1000;

// The sudo check is a nudge to the model, not a security boundary; the sandbox
// user is the real guard.
const SUDO = /\bsudo\b/;

/** Keep the first and last halves of `text` (by bytes) when it exceeds `max`. */
export function truncateMiddle(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = bytes.length - half * 2;
  const head = bytes.subarray(0, half).toString();
  const tail = bytes.subarray(bytes.length - half).toString();
  return `${head}\n...[truncated ${dropped} bytes]...\n${tail}`;
}

export const bash: Tool = {
  spec: {
    name: "bash",
    description: "Run a shell command in the working directory. Output is byte-capped. No sudo.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const command = String(input.command ?? "");
    if (SUDO.test(command)) return "refused: sudo is not allowed";

    ctx.signal?.throwIfAborted();
    const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], {
      cwd: ctx.cwd,
      detached: true,
      stdout: "pipe",
      stdin: "ignore",
      timeout: TIMEOUT_MS,
    });
    const kill = () => killGroup(proc);
    process.once("exit", kill); // detached tools must not outlive a normal harness/agent exit
    ctx.signal?.addEventListener("abort", kill, { once: true });
    if (ctx.signal?.aborted) kill();
    let output: string, code: number;
    try { [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]); }
    finally { ctx.signal?.removeEventListener("abort", kill); process.off("exit", kill); }
    ctx.signal?.throwIfAborted();

    let result = output;
    if (proc.signalCode === "SIGTERM" && proc.killed) result += `\n[timed out after ${TIMEOUT_MS / 1000}s]`;
    if (code !== 0) result += `${result.endsWith("\n") || result === "" ? "" : "\n"}[exit ${code}]`;

    const { maxToolResultBytes } = await loadConfig();
    return truncateMiddle(result, maxToolResultBytes);
  },
};
