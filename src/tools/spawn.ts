import { paths } from "../config";
import { local, sessionId, type Runner } from "../runner";
import { open } from "../transcript";
import type { Tool } from "./index";

// Orchestrator-only. Seeds the agent's transcript with the prompt, then starts
// it in a worktree on `branch`. Spawning again on the same branch and role
// appends to that transcript, so a second review round keeps its context,
// and a worker given a follow-up task on its open branch keeps its own. The
// description holds the orchestrator's reuse-or-new-branch rule.
export function makeSpawn(runner: Runner): Tool {
  return {
    spec: {
      name: "spawn",
      description:
        "Start an agent on a git branch in its own worktree and tmux window. The prompt is the only thing it is told. " +
        "role 'worker' (default) or 'reviewer'. It reports back to you through `message`.\n\n" +
        "Spawning the same role on a branch again continues that agent: same transcript, so it keeps its context, and same worktree, with its earlier commits. " +
        "The prompt is its next instruction. One agent codes on a branch at a time, so spawn an agent again only after its last run has reported. " +
        "Merged branches are cleaned up automatically and cannot be reused.\n\n" +
        "Reuse or new branch, decided per task when you plan:\n" +
        "- Reuse an open branch (spawn its worker again with the new task) when the new work touches the same files or feature, is small, and no reviewer is working on that branch right now.\n" +
        "- Start a new branch when the work is independent of it, would make a PR under review much bigger, needs its own merge order, or the existing branch is waiting on CI or merge.\n" +
        "- If unsure, say so in the plan table and let the user choose.\n" +
        "Name what is reused in the plan table: \"<branch> (existing, reused)\".",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Everything the agent needs to know to do the job. Never limit its report's length or ask for a short, brief or summary report; it reports in full." },
          branch: { type: "string", description: "Branch to work on: an open branch to reuse it, or a new name, created from HEAD." },
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
