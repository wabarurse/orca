import { attachmentSchema, forwardImages } from "../image-handoff";
import { imageContent, type ImageRef } from "../images";
import { delay, publishLaunch } from "../cancellation";
import { prepareTaskRun, stopTaskRun } from "../tasks";
import { paths } from "../config";
import { local, sessionId, type Runner } from "../runner";
import { open } from "../transcript";
import type { Tool, ToolContext } from "./index";

// Orchestrator-only. Seeds the agent's transcript with the prompt, then starts
// it in a worktree on `branch`. Spawning again on the same branch and role
// appends to that transcript, so a second review round keeps its context,
// and a worker given a follow-up task on its open branch keeps its own. The
// description holds the orchestrator's reuse-or-new-branch rule.
/** How long spawn waits for a live agent on the branch to finish, and how often it looks. */
export interface SpawnWait { waitMs: number; pollMs: number }
const WAIT: SpawnWait = { waitMs: 20_000, pollMs: 250 };

/** The branch's agents still live after waiting up to `waitMs`; [] when none, or when tmux could not be asked. */
async function stillLive(runner: Runner, project: string, branch: string, wait: SpawnWait, signal?: AbortSignal): Promise<string[]> {
  const ids = [sessionId("worker", branch), sessionId("reviewer", branch)];
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const live = await runner.running(project, ids, signal).catch(() => null);
    if (!live?.length || Date.now() >= deadline) return live ?? [];
    await delay(wait.pollMs, signal);
  }
}

export function makeSpawn(runner: Runner, wait: SpawnWait = WAIT): Tool {
  return {
    spec: {
      name: "spawn",
      description:
        "Start an agent on a git branch in its own worktree and tmux window. The prompt is the only thing it is told. " +
        "role 'worker' (default) or 'reviewer'. It reports back to you through `message`.\n\n" +
        "Spawning the same role on a branch again continues that agent: same transcript, so it keeps its context, and same worktree, with its earlier commits. " +
        "The prompt is its next instruction. One agent works on a branch at a time: spawn waits briefly, then refuses while the branch's worker or reviewer is still running, " +
        "so spawn again only after it has reported or exited.\n" +
        "Never spawn on a branch whose PR is merged; the harness stops and cleans those up (within ~30s, when gh is available). Follow-up work goes on a new branch.\n\n" +
        "Proportionate review: judge the actual diff and worker evidence, not extensions. Pure wording/formatting in README/docs/comments may go directly to reviewMode: watch-ci for publication and bounded requested-text/link validation, with a risk rationale, not a fake code-review round. " +
        "Changes to behavior, security, config, agent instructions or executable examples (even in .md) need substantive risk review and relevant checks, within maxReviewRounds; 0 disables code-review rounds, not validation. " +
        "Tell the reviewer its mode, risk rationale, relevant evidence and review-budget state, including any explicitly exhausted cap. With rounds enabled, newly discovered material review needs must return to you before readiness; respect the cap and disclose any exhausted-budget exception. " +
        "Only explicitly tagged review dispatches count as code-review rounds; never infer rounds from prose.\n\n" +
        "Reuse or new branch, decided per task when you plan:\n" +
        "- Reuse the same taskId and branch for corrections to an existing task or unmerged PR, including review feedback, CI failures and user-requested fixes after a ready report. " +
        "CI or PR publication does not require a fresh branch for these corrections. Use task list/get to find the existing task and refresh its PR state with task pr before resuming. " +
        "If its agent is still running, message it; otherwise spawn the worker on that branch with the correction. " +
        "Run the task flow again; the reviewer pushes to the same PR and validates its updated head. Do not register a new task or use a temporary branch/cherry-pick workaround for the correction.\n" +
        "- A separate small follow-up on the same feature may reuse a branch before PR publication, with a new taskId and its own task flow. " +
        "Its whole transcript is resent each call, so avoid a long series of tasks on one worker.\n" +
        "- Start a new branch for independent work, a separate task after PR publication, work needing its own merge order, or work after the original PR has merged.\n" +
        "- If unsure, say so in the plan table and let the user choose.\n" +
        "In the plan table, mark a reused branch (existing): \"<branch> (existing)\".",
      input_schema: {
        type: "object",
        properties: {
          attachments: attachmentSchema,
          taskId: { type: "string", description: "Registered authorized task UUID. Keep it for retries, review rounds and fixes to the same unmerged PR, even after CI or a ready report. Register a new ID only for separate work." },
          prompt: { type: "string", description: "Everything the agent needs to know to do the job. Never limit its report's length or ask for a short, brief or summary report; it reports in full." },
          branch: { type: "string", description: "Task branch: an open branch to reuse it, or a new name created from the original checkout's default branch (HEAD for legacy projects). Never use the default branch itself." },
          reviewMode: { type: "string", enum: ["review", "watch-ci"], description: "Required when role is reviewer; explicitly identify: code review or publication/validation (including bounded editorial checks). watch-ci is not a code-review round." },
          role: { type: "string", enum: ["worker", "reviewer"], description: "Default worker." },
        },
        required: ["prompt", "branch", "taskId"],
      },
    },
    async run(input, ctx) {
      if (ctx.role !== "orchestrator") return "refused: only the orchestrator can spawn";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const branch = typeof input.branch === "string" ? input.branch.trim() : "";
      const role = input.role === "reviewer" ? "reviewer" : "worker";
      if (!prompt || !branch || typeof input.taskId !== "string") return "refused: prompt, branch and registered taskId are required";

      if (role === "reviewer" && input.reviewMode !== "review" && input.reviewMode !== "watch-ci") return "refused: reviewer requires reviewMode: review or watch-ci (prompt text does not select the mode)";
      if (role === "worker" && input.reviewMode !== undefined) return "refused: reviewMode is only valid for reviewer";

      const attachments = await forwardImages(input.attachments, ctx);
      // One agent per branch: a reported agent may still be finishing, so wait briefly for it.
      const busy = await stillLive(runner, ctx.project, branch, wait, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (busy.length) return `refused: ${busy[0]} is still running on ${branch}; message it, or spawn again after it reports or exits`;

      if (input.reviewMode !== undefined && input.reviewMode !== "review" && input.reviewMode !== "watch-ci") return "refused: invalid reviewMode";
      return launch(runner, prompt, branch, role, input.taskId, ctx, attachments, role === "reviewer" ? input.reviewMode as "review" | "watch-ci" : undefined);
    },
  };
}

/** Publish identity before the first transcript entry (the TUI lists transcripts). */
async function launch(runner: Runner, prompt: string, branch: string, role: "worker" | "reviewer", taskId: string, ctx: ToolContext, attachments: ImageRef[] = [], reviewMode?: "review" | "watch-ci"): Promise<string> {
  const id = sessionId(role, branch);
  const run = crypto.randomUUID();
  await prepareTaskRun(ctx.project, taskId, branch, { id: run, agent: id, role, ...(reviewMode ? { reviewMode } : {}) });
  try {
    publishLaunch(ctx.project, id, run);
    const t = open(paths.transcript(ctx.project, id));
    if (t.head() === null) await t.append({ type: "meta", role, branch, model: "" });
    await t.append({ type: "message", message: { role: "user", content: imageContent(`Branch: ${branch}\n\n${prompt}`, attachments) } });
    ctx.signal?.throwIfAborted();
    await runner.start({ project: ctx.project, role, branch, run, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return id;
  } catch (error) {
    await stopTaskRun(ctx.project, run, ctx.signal?.aborted ? "cancelled" : "blocked", "agent launch failed; no successful start confirmed", true);
    throw error;
  }
}

export const spawn: Tool = makeSpawn(local);
