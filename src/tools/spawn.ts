import { paths } from "../config";
import { local, sessionId, type Runner } from "../runner";
import { open } from "../transcript";
import type { Tool } from "./index";

// Orchestrator-only. Seeds the agent's transcript with the prompt, then starts
// it in a worktree on `branch`. Spawning again on the same branch and role
// appends to that transcript, so a second review round keeps its context.
export function makeSpawn(runner: Runner): Tool {
  return {
    spec: {
      name: "spawn",
      description:
        "Start an agent on a git branch in its own worktree and tmux window. The prompt is the only thing it is told. " +
        "role 'worker' (default) or 'reviewer'. It reports back to you through `message`.",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Everything the agent needs to know to do the job." },
          branch: { type: "string", description: "Branch to work on; created from HEAD if new." },
          role: { type: "string", enum: ["worker", "reviewer"], description: "Default worker." },
        },
        required: ["prompt", "branch"],
      },
    },
    async run(input, ctx) {
      if (ctx.role !== "orchestrator") return "refused: only the orchestrator can spawn";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const branch = typeof input.branch === "string" ? input.branch.trim() : "";
      const role = input.role === "reviewer" ? "reviewer" : "worker";
      if (!prompt || !branch) return "refused: prompt and branch are required";

      const id = sessionId(role, branch);
      const t = open(paths.transcript(ctx.project, id));
      if (t.head() === null) await t.append({ type: "meta", role, branch, model: "" });
      await t.append({ type: "message", message: { role: "user", content: `Branch: ${branch}\n\n${prompt}` } });

      await runner.start({ project: ctx.project, role, branch });
      return id;
    },
  };
}

export const spawn: Tool = makeSpawn(local);
