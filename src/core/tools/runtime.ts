import { BUILD_ID } from "../../config";
import { runtimeContexts, usageSummary } from "../data/knowledge";
import { listProcesses } from "../data/processes";
import type { Tool } from "./registry";

export const runtime: Tool = {
  parallel: () => true,
  spec: { name: "runtime", description: "Inspect loaded build/context identities, background work and measured usage. Source or installed files do not prove a running process loaded them. Older context observations are historical, not liveness proof.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["status", "usage"] }, all_projects: { type: "boolean" } }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "usage") return JSON.stringify(await usageSummary(input.all_projects === true ? undefined : ctx.project));
    if (input.action !== "status") throw new Error("unknown runtime action");
    return JSON.stringify({ loadedBuild: BUILD_ID, agents: await runtimeContexts(ctx.project), processes: (await listProcesses(ctx.project)).map(p => ({ id: p.id, owner: p.owner, state: p.state, readyUrl: p.readyAt ? p.readyUrl : undefined, observedAt: p.updatedAt })) });
  },
};
