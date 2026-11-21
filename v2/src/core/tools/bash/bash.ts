// Run one shell command in the agent's folder, in its own process group, with a timeout. Output beyond the
// result cap is saved whole under the conversation's folder and the result shows its head, tail and path.
// Long-running commands are the processes plugin's `process` tool.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths } from "../../../config";
import { DATA_SENTENCE } from "../../bubbles";
import type { Tool } from "../registry";
import { hint } from "./hints";
import { readOnly } from "./readonly";

export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SUDO = /\bsudo\b/;

/** Keep both ends of output that is over `max` bytes. */
export function truncateMiddle(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${bytes.subarray(0, half).toString()}\n...[truncated ${bytes.length - half * 2} bytes]...\n${bytes.subarray(-half).toString()}`;
}

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

/** The environment every command an agent runs gets. */
export function agentEnv(conversation: string, agent: string, data: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ORCA_DATA: data, ORCA_CONVERSATION: conversation, ORCA_AGENT: agent, ORCA_ARTIFACTS: join(paths.conversation(conversation), "artifacts", agent) };
}

export const bash: Tool = {
  parallel: input => typeof input.command === "string" && readOnly(input.command),
  spec: {
    name: "bash",
    description: `Run a non-interactive shell command in the working directory. No sudo. Change files with edit or write rather than sed -i. Set timeout_ms (default and maximum 600000) for checks that may stall. Use web_search to look things up, curl only for a known URL. Save evidence (screenshots, logs) in $ORCA_ARTIFACTS. ${DATA_SENTENCE} Large output is saved whole and the result shows its head, tail and path. Send independent read-only commands together in one response; they run concurrently.`,
    input_schema: { type: "object", properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
    }, required: ["command"] },
  },
  async run(input, ctx) {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.trim().length === 0) throw new Error("command must be a non-empty string");
    if (SUDO.test(command)) return "refused: sudo is not allowed";
    const timeoutMs = typeof input.timeout_ms === "number" && input.timeout_ms > 0 ? Math.min(MAX_TIMEOUT_MS, Math.floor(input.timeout_ms)) : MAX_TIMEOUT_MS;
    const config = await loadConfig();
    const env = agentEnv(ctx.conversation, ctx.agent, ctx.data);
    await mkdir(env.ORCA_ARTIFACTS ?? ctx.cwd, { recursive: true });
    const proc = Bun.spawn(["bash", "-c", `exec 2>&1\n${command}`], { cwd: ctx.cwd, env, stdout: "pipe", stdin: "ignore", detached: true });
    let timedOut = false, limited = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(proc.pid); }, timeoutMs);
    const abort = (): void => { killGroup(proc.pid); };
    ctx.signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of proc.stdout) {
        const room = config.maxToolOutputBytes - bytes;
        if (room <= 0) { limited = true; killGroup(proc.pid); break; }
        const part = chunk.subarray(0, room);
        chunks.push(part);
        bytes += part.length;
      }
      await proc.exited;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
    ctx.signal.throwIfAborted();
    const output = Buffer.concat(chunks).toString("utf8");
    const notes: string[] = [];
    const nudge = hint(command);
    if (nudge !== undefined) notes.push(nudge);
    if (limited) notes.push("[output limit reached; command terminated; saved output is incomplete]");
    if (timedOut) notes.push(`[timed out after ${timeoutMs / 1000}s; saved output is incomplete]`);
    const code = proc.exitCode ?? -1;
    if (code !== 0 && !timedOut) notes.push(`[exit ${code}]`);
    let shown = output;
    if (Buffer.byteLength(output) > config.maxToolResultBytes) {
      const dir = join(paths.conversation(ctx.conversation), "tool-outputs");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${crypto.randomUUID()}.txt`);
      await Bun.write(file, output);
      shown = truncateMiddle(output, Math.min(4096, config.maxToolResultBytes));
      notes.push(`[full output: ${file}]`);
    }
    return [shown.replace(/\n$/, ""), ...notes].filter(part => part.length > 0).join("\n");
  },
};
