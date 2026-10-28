import { updateContext, workingContext, type WorkingContext } from "../data/knowledge";
import { readProcess } from "../data/processes";
import type { Tool } from "./registry";

export const contextTool: Tool = {
  spec: { name: "context", description: "Inspect or maintain the small active working brief: goal, decisions and usable result references. Preserve the user's latest corrections. Record a running preview with its process handle; only runtime-observed readiness is marked verified at observedAt (historical observation, not a promise of ongoing availability). No workflow mode or publication stage is required.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["get", "update", "result"] }, goal: { type: "string" }, decisions: { type: "array", items: { type: "string" } }, label: { type: "string" }, location: { type: "string" }, revision: { type: "string" }, evidence: { type: "string" }, process_id: { type: "string" } }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "get") return JSON.stringify(await workingContext(ctx.project));
    if (ctx.role !== "orchestrator") throw new Error("workers return results to the orchestrator; only it maintains the shared goal");
    if (input.action === "update") {
      const patch: Partial<WorkingContext> = {};
      if (input.goal !== undefined) {
        if (typeof input.goal !== "string" || input.goal.length > 2000) throw new Error("goal must be at most 2000 characters");
        patch.goal = input.goal;
      }
      if (input.decisions !== undefined) {
        if (!Array.isArray(input.decisions) || input.decisions.length > 20 || input.decisions.some(d => typeof d !== "string" || d.length > 300)) throw new Error("decisions must be up to 20 concise strings");
        patch.decisions = input.decisions as string[];
      }
      return JSON.stringify(await updateContext(ctx.project, patch));
    }
    if (input.action === "result") {
      if (typeof input.label !== "string" || typeof input.location !== "string" || input.label.length > 200 || input.location.length > 1000) throw new Error("result needs a concise label and location");
      let status: "reported" | "verified" = "reported", observedAt: string | undefined;
      if (typeof input.process_id === "string") {
        const p = await readProcess(ctx.project, input.process_id);
        if (p.state === "running" && p.readyAt && p.readyUrl === input.location) { status = "verified"; observedAt = p.readyAt; }
      }
      const result = { processId: typeof input.process_id === "string" ? input.process_id : undefined, observedAt, label: input.label, location: input.location, revision: typeof input.revision === "string" ? input.revision : undefined, evidence: typeof input.evidence === "string" ? input.evidence : undefined, status };
      const old = await workingContext(ctx.project);
      return JSON.stringify(await updateContext(ctx.project, { results: [...(old.results ?? []).filter(r => r.label !== result.label), result].slice(-10) }));
    }
    throw new Error("unknown context action");
  },
};
