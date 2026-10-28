import { rm } from "node:fs/promises";
import { controlProcess, liveProcess, processDirectory, listProcesses, processOutput, readProcess, reconcileProcesses } from "../data/processes";
import { sessionId } from "../tmux";
import type { Tool } from "./registry";

export const processTool: Tool = {
  spec: { name: "process", description: "Inspect your background command, retrieve output by byte cursor, send stdin, stop it, or forget a terminal handle and its saved output. Completion arrives as a runtime event; do not repeatedly poll. The orchestrator may inspect/control project processes for coordination.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "output", "input", "stop", "forget"] }, id: { type: "string" }, cursor: { type: "integer", minimum: 0 }, text: { type: "string" } }, required: ["action"] } },
  async run(input, ctx) {
    await reconcileProcesses(ctx.project);
    const owner = sessionId(ctx.role, ctx.branch);
    if (input.action === "list") return JSON.stringify((await listProcesses(ctx.project)).filter(p => ctx.role === "orchestrator" || p.owner === owner)
      .map(p => ({ id: p.id, owner: p.owner, state: p.state, readyUrl: p.readyAt ? p.readyUrl : undefined, exitCode: p.exitCode })));
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
