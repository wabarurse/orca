// The processes plugin: commands that outlive one tool call (test suites, dev servers). `process start` runs one
// detached in the agent's folder; list, output, wait and stop look after it; the daemon tells the owner when it ends.
import { join } from "node:path";
import { definePlugin, type Plugin } from "../../core/plugins";
import { agentEnv } from "../../core/tools/bash";
import { describe, getProc, listProcs, markNotified, readOutput, startProc, stopProc, tail, type Proc } from "./store";

const MAX_WAIT_MS = 60_000;
const SUDO = /\bsudo\b/;

const ended = (proc: Proc, lines: string[]): string => [describe(proc), ...lines].join("\n");

const plugin: Plugin = definePlugin({
  name: "processes",
  description: "Long-running commands (tests, servers) agents start in the background and check on; the owner is told when one ends.",
  tools: [{
    roles: ["orchestrator", "worker", "reviewer"],
    replaces: false,
    tool: {
      parallel: input => input.action === "list" || input.action === "output",
      spec: {
        name: "process",
        description: "Run a long command in the background in the working directory and check on it. start {command, timeout_ms} returns an id; list shows this conversation's processes; output {id, cursor} returns output since a byte cursor (start at 0) and the next cursor; wait {id, timeout_ms up to 60000} returns when it ends or the time passes; stop {id} ends its process group. You are told in your inbox when a process you started ends. Use wait or output rather than sleeping in bash.",
        input_schema: { type: "object", properties: {
          action: { type: "string", enum: ["start", "list", "output", "wait", "stop"] },
          command: { type: "string" },
          id: { type: "string" },
          cursor: { type: "integer", minimum: 0 },
          timeout_ms: { type: "integer", minimum: 1 },
        }, required: ["action"] },
      },
      async run(input, ctx) {
        const dir = join(ctx.data, "processes");
        if (input.action === "start") {
          const command = typeof input.command === "string" ? input.command : "";
          if (command.trim().length === 0) return "refused: start needs a command";
          if (SUDO.test(command)) return "refused: sudo is not allowed";
          const timeoutMs = typeof input.timeout_ms === "number" && input.timeout_ms > 0 ? Math.floor(input.timeout_ms) : null;
          const proc = await startProc(dir, { owner: ctx.agent, command, cwd: ctx.cwd, env: agentEnv(ctx.conversation, ctx.agent, ctx.data), timeoutMs });
          return `started ${proc.id} (pid ${proc.pid})`;
        }
        if (input.action === "list") {
          const procs = await listProcs(dir);
          return procs.length === 0 ? "no processes" : procs.map(describe).join("\n");
        }
        const id = typeof input.id === "string" ? input.id : "";
        let proc = await getProc(dir, id);
        if (proc === null) return `refused: no process ${id}`;
        if (input.action === "stop") {
          proc = await stopProc(dir, proc);
          return ended(proc, (await tail(dir, id, 20)).map(line => `  ${line}`));
        }
        if (input.action === "output") {
          const cursor = typeof input.cursor === "number" && input.cursor > 0 ? Math.floor(input.cursor) : 0;
          const out = await readOutput(dir, id, cursor);
          if (!out.more && proc.state !== "running") proc = await markNotified(dir, proc);
          return [out.text.replace(/\n$/, ""), `[${describe(proc)}; next cursor ${out.next}${out.more ? "; more output waiting" : ""}]`].filter(p => p.length > 0).join("\n");
        }
        if (input.action === "wait") {
          const limit = Math.min(MAX_WAIT_MS, typeof input.timeout_ms === "number" && input.timeout_ms > 0 ? Math.floor(input.timeout_ms) : MAX_WAIT_MS);
          const until = Date.now() + limit;
          while (proc.state === "running" && Date.now() < until) {
            ctx.signal.throwIfAborted();
            await Bun.sleep(Math.min(250, Math.max(0, until - Date.now())));
            proc = await getProc(dir, id) ?? proc;
          }
          ctx.signal.throwIfAborted();
          if (proc.state === "running") return `${describe(proc)} (still running after ${limit / 1000}s)`;
          proc = await markNotified(dir, proc);
          return ended(proc, (await tail(dir, id, 20)).map(line => `  ${line}`));
        }
        return `refused: unknown action ${String(input.action)}`;
      },
    },
  }],
  prompt: [
    { role: "worker", text: "Start long test runs and servers with process start; use process wait or output instead of sleeping in bash." },
    { role: "orchestrator", text: "Start long commands and servers with process start; use process wait or output instead of sleeping in bash." },
  ],
  skills: [],
  storage: [{ scope: "conversation", about: "processes/<id>.json the record, <id>.log the output, <id>.exit the exit code" }],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  bundles: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
