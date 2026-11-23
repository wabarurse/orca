import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, type Plugin } from "../../core/plugins";
import { agentEnv, MAX_TIMEOUT_MS, truncateMiddle } from "../../core/tools/bash";
import { sandboxArgv, type Platform } from "./sandbox";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_BYTES = 32 * 1024;
const READ_LIMIT = 1024 * 1024;
const ID = /^[a-z0-9]{8}$/;

const host: Platform = { os: process.platform, which: bin => Bun.which(bin) };

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { return; } }
}

const plugin: Plugin = definePlugin({
  name: "sandbox",
  description: "Disposable isolated runs: a command that can read the working directory but write only to a scratch folder.",
  tools: [{
    roles: ["worker", "reviewer"],
    replaces: false,
    tool: {
      parallel: () => false,
      spec: {
        name: "sandbox",
        description: "Run a command isolated from the filesystem: it reads the working directory but may write only to a fresh scratch folder ($ORCA_SCRATCH, also TMPDIR), which is kept for reading results. Use it to try untrusted code or commands whose writes you do not want. run {command, timeout_ms} returns the output, exit code and scratch path; clean {id} removes the scratch folder. Refuses when no sandbox is available; it never runs unsandboxed.",
        input_schema: { type: "object", properties: {
          action: { type: "string", enum: ["run", "clean"] },
          command: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
          id: { type: "string" },
        }, required: ["action"] },
      },
      async run(input, ctx) {
        const root = join(ctx.data, "sandbox");
        if (input.action === "clean") {
          const id = typeof input.id === "string" ? input.id : "";
          if (!ID.test(id) || !await Bun.file(join(root, id, ".sandbox")).exists()) return `refused: no sandbox ${id}`;
          await rm(join(root, id), { recursive: true, force: true });
          return `removed ${id}`;
        }
        if (input.action !== "run") return `refused: unknown action ${String(input.action)}`;
        const command = typeof input.command === "string" ? input.command : "";
        if (command.trim().length === 0) return "refused: run needs a command";
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
        await mkdir(join(root, id, "tmp"), { recursive: true });
        await Bun.write(join(root, id, ".sandbox"), "");
        const scratch = await realpath(join(root, id));
        const plan = sandboxArgv(host, scratch, ctx.cwd, `exec 2>&1\n${command}`);
        if (!plan.ok) { await rm(scratch, { recursive: true, force: true }); return `refused: ${plan.error}`; }
        const timeoutMs = typeof input.timeout_ms === "number" && input.timeout_ms > 0 ? Math.min(MAX_TIMEOUT_MS, Math.floor(input.timeout_ms)) : DEFAULT_TIMEOUT_MS;
        const env = { ...agentEnv(ctx.conversation, ctx.agent, ctx.data), ORCA_SCRATCH: scratch, ORCA_ARTIFACTS: scratch, TMPDIR: join(scratch, "tmp") };
        const proc = Bun.spawn(plan.data, { cwd: ctx.cwd, env, stdin: "ignore", stdout: "pipe", detached: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killGroup(proc.pid); }, timeoutMs);
        const abort = (): void => { killGroup(proc.pid); };
        ctx.signal.addEventListener("abort", abort, { once: true });
        const chunks: Uint8Array[] = [];
        let bytes = 0, limited = false;
        try {
          for await (const chunk of proc.stdout) {
            if (bytes + chunk.length > READ_LIMIT) { limited = true; killGroup(proc.pid); break; }
            chunks.push(chunk);
            bytes += chunk.length;
          }
          await proc.exited;
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", abort);
        }
        ctx.signal.throwIfAborted();
        const output = Buffer.concat(chunks).toString("utf8");
        const end = limited ? "output over 1 MiB; terminated" : timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit ${proc.exitCode ?? -1}`;
        return [truncateMiddle(output.replace(/\n$/, ""), OUTPUT_BYTES), `[sandbox ${id}: ${end}; scratch ${scratch}]`].filter(p => p.length > 0).join("\n");
      },
    },
  }],
  prompt: [],
  skills: [],
  storage: [{ scope: "conversation", about: "sandbox/<id>/: each run's scratch folder, the only place it could write" }],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  bundles: [],
  retention: [],
  guard: [],
  ui: "./ui.ts",
  background: null,
});

export default plugin;
