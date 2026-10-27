import { attachmentSchema, forwardImages } from "./attachments";
import { consume, content } from "../data/inbox";
import { imageContent } from "../data/images";
import type { ImageRef } from "../../protocol";
import { delay, publishLaunch } from "../tmux";
import { prepareTaskRun, stopTaskRun, taskForRun } from "../data/tasks";
import { paths } from "../../config";
import { local, sessionId, type Runner } from "../tmux";
import { open } from "../data/transcripts";
import type { Tool, ToolContext } from "./registry";

// Orchestrator-only. Seeds the agent's transcript with the prompt, then starts
// it in a worktree on `branch`. Spawning again on the same branch and role
// appends to that transcript, so a second review round keeps its context,
// and a worker given a follow-up task on its open branch keeps its own. The
// description holds the orchestrator's reuse-or-new-branch rule.
/** How long spawn waits for a live agent on the branch to finish, and how often it looks. */
export interface SpawnWait { waitMs: number; pollMs: number }
const WAIT: SpawnWait = { waitMs: 20_000, pollMs: 250 };

/** The branch's live agents after waiting; null means ownership could not be checked. */
async function stillLive(runner: Runner, project: string, branch: string, wait: SpawnWait, signal?: AbortSignal): Promise<string[] | null> {
  const ids = [sessionId("worker", branch), sessionId("reviewer", branch)];
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const live = await runner.running(project, ids, signal).catch(() => null);
    if (!live?.length || Date.now() >= deadline) return live;
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
          prompt: { type: "string", description: "Everything the agent needs, including prior check commands, tested commit/code state, results and saved failure-output paths. Workers run only relevant checks once per checked code state. Reviewers inspect failed-check output, diff and complexity; they never run tests or validation commands. Never request full suites, baseline comparisons or duplicate tests, including in watch-ci. Never limit its report's length or ask for a short, brief or summary report; it reports in full." },
          branch: { type: "string", description: "Task branch: an open branch to reuse it, or a new name created from the original checkout's default branch (HEAD for legacy projects). Never use the default branch itself." },
          reviewMode: { type: "string", enum: ["review", "watch-ci"], description: "Required when role is reviewer; explicitly identify: code review or CI-only validation. CI is not another review round." },
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
      if (busy === null) return `refused: cannot verify whether agents are still running on ${branch}; restore liveness checks before retrying`;
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
    await consume(ctx.project, id, t, async inbox => {
      ctx.signal?.throwIfAborted();
      const queued = content(inbox);
      const next = imageContent(`Branch: ${branch}\n\n${prompt}`, attachments);
      // One durable entry: never acknowledge STOP without also preserving its
      // position before this explicit instruction. No text/timestamp inference.
      const blocks = (value: typeof next) => typeof value === "string" ? [{ type: "text" as const, text: value }] : value;
      await t.append({ type: "message", inbox, message: { role: "user",
        content: inbox.length ? [...blocks(queued), ...blocks(next)] : next } }, ctx.signal);
    }, true);
    ctx.signal?.throwIfAborted();
    await runner.start({ project: ctx.project, role, branch, run, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return id;
  } catch (error) {
    await stopTaskRun(ctx.project, run, ctx.signal?.aborted ? "cancelled" : "blocked", "agent launch failed; no successful start confirmed", true);
    if (ctx.signal?.aborted) throw error;
    // The tool result is the orchestrator's notice of a death before the agent started (runner.confirmLaunch closes the run), unless the error says one went out already.
    throw new Error(`spawn: ${id} did not start: ${error instanceof Error ? error.message : String(error)}\nNothing is running on ${branch}; ${await taskState(ctx.project, run)}. Fix the cause, then spawn again with the same taskId and branch.`);
  }
}

/** What the registry recorded for this run after the failure: spawn's "blocked (launch failed)" unless an earlier close got there first. */
async function taskState(project: string, run: string): Promise<string> {
  const task = await taskForRun(project, run).catch(() => undefined);
  const r = task?.runs.at(-1);
  if (!task || !r) return "its task run could not be read";
  const attention = task.attention ? `, attention ${task.attention.kind}: ${task.attention.reason}` : "";
  return `its task run is ${r.state}${r.state === "failed" ? " (launch failed)" : ""}${attention}`;
}

export const spawn: Tool = makeSpawn(local);
