import { rm } from "node:fs/promises";
import { launchProcess, controlProcess, liveProcess, processDirectory, listProcesses, processOutput, readProcess, reconcileProcesses } from "../data/processes";
import { cliCommand, sessionId } from "../tmux";
import { originRepo } from "../data/tasks";
import { sha } from "../../protocol/task";
import type { Tool } from "./registry";

export const processTool: Tool = {
  spec: { name: "process", description: "Inspect your background command, retrieve output by byte cursor, send stdin, stop it, or forget a terminal handle and its saved output. Completion arrives as a runtime event with an output tail. Use watch_pr for an existing GitHub PR number and full head SHA in the project origin. Shares one live watch per PR head in this project. If reused, the receipt names the owner who receives completion. After starting or finding a watch, do independent work or end your turn. Never use Bash sleep loops to check progress. Checks alone do not establish merge readiness. The orchestrator may inspect/control project processes for coordination.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "output", "input", "stop", "forget", "watch_pr"] }, id: { type: "string" }, cursor: { type: "integer", minimum: 0 }, text: { type: "string" }, number: { type: "integer", minimum: 1, description: "GitHub PR number for watch_pr." }, head: { type: "string", description: "Full current PR head SHA for watch_pr." } }, required: ["action"] } },
  async run(input, ctx) {
    await reconcileProcesses(ctx.project);
    const owner = sessionId(ctx.role, ctx.branch);
    if (input.action === "list") return JSON.stringify((await listProcesses(ctx.project)).filter(p => ctx.role === "orchestrator" || p.owner === owner)
      .map(p => ({ id: p.id, owner: p.owner, state: p.state, readyUrl: p.readyAt ? p.readyUrl : undefined, exitCode: p.exitCode })));
    if (input.action === "watch_pr") {
      const { number, head } = input;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof head !== "string" || !sha(head)) {
        throw new Error("watch_pr requires a GitHub PR number and full head SHA");
      }
      const repository = await originRepo(ctx.project);
      if (!repository) throw new Error("project origin is not on GitHub");
      const at = new Date().toISOString();
      return JSON.stringify(await launchProcess({ id: crypto.randomUUID(), project: ctx.project, owner,
        role: ctx.role, branch: ctx.branch, run: ctx.run, call: ctx.callId, cwd: ctx.cwd, command: `Watch checks for ${repository}#${number}`,
        prChecks: { repository: repository.toLowerCase(), number, head: head.toLowerCase() },
        createdAt: at, updatedAt: at, state: "starting", timeoutMs: 30 * 60_000, maxBytes: 8192, notify: true, events: [] },
      cliCommand(), 0, ctx.signal, ctx.executionEpoch));
    }
    const p = await readProcess(ctx.project, String(input.id ?? ""));
    if (ctx.role !== "orchestrator" && p.owner !== owner) throw new Error("process belongs to another agent");
    if (input.action === "forget") {
      if (liveProcess(p) || p.state === "unknown" || p.events.some(e => !e.delivered)) throw new Error("only settled processes with delivered events can be forgotten");
      await rm(processDirectory(ctx.project, p.id), { recursive: true }); return `forgot ${p.id}`;
    }
    if (input.action === "status") return JSON.stringify({ id: p.id, owner: p.owner, state: p.state, exitCode: p.exitCode, reason: p.reason, readyUrl: p.readyAt ? p.readyUrl : undefined, updatedAt: p.updatedAt });
    if (input.action === "output") return JSON.stringify(await processOutput(ctx.project, p.id, Number(input.cursor ?? 0)));
    if (input.action === "stop" || input.action === "input") {
      await controlProcess(ctx.project, p.id, input.action, typeof input.text === "string" ? input.text : undefined);
      return `${input.action} delivered to ${p.id}`;
    }
    throw new Error("unknown process action");
  },
};
