import { prepareStackSpawn } from "../data/tasks";
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
import { withStorageLock } from "../data";
import { join } from "node:path";

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
      description: "Delegate an outcome whose intermediate work would grow coordinator context: many reads, long outputs or repeated trials/checks, regardless of task type. Keep bounded actions with short results direct when delegation adds overhead. This does not authorize commit, review, publication or CI. New work starts with a fresh brief, not the orchestrator transcript. Branch is optional: a new work branch is allocated if omitted. Reuse an existing branch for feedback on the same unmerged result. A live worker receives message instead. Set fresh=true to reset only the idle worker's model context while retaining workspace and full history. taskId is optional for ordinary work and required for tracked publication/dependencies. Reviewer role is an explicit independent assessment, not an automatic next stage. Never reuse a merged branch.",
      input_schema: {
        type: "object",
        properties: {
          attachments: attachmentSchema,
          taskId: { type: "string", description: "Registered authorized task UUID. Keep it for retries, review rounds and fixes to the same unmerged PR, even after CI or a ready report. Register a new ID only for separate work." },
          prompt: { type: "string", description: "Focused outcome through validation, acceptance criteria, authorized scope, relevant preferences/instructions, latest corrections, prior attempts and evidence references; not raw conversation or logs. Request a concise outcome, checked revision, validation, evidence references, uncertainty and decisions needed; full detail stays in artifacts." },
          fresh: { type: "boolean", description: "Start with fresh model context on an idle existing branch; retain workspace and original transcript." },
          branch: { type: "string", description: "Task branch: an open branch to reuse it, or a new name created from the original checkout's default branch (HEAD for legacy projects), or explicit baseCommit from authorized prerequisite checkpoints. Never use the default branch itself." },
          baseCommit: { type: "string", description: "Optional explicit immutable prerequisite checkpoint commit for a NEW local stacked branch. Requires registered explicit task dependencies and all prerequisite code in this commit. No automatic composition/merge. Prerequisites may remain open for development; publication waits for all verified merges." },
          reviewMode: { type: "string", enum: ["review", "watch-ci"], description: "Required when role is reviewer; explicitly identify: code review or CI-only validation. CI is not another review round." },
          role: { type: "string", enum: ["worker", "reviewer"], description: "Default worker." },
        },
        required: ["prompt"],
      },
    },
    async run(input, ctx) {
      if (ctx.role !== "orchestrator") return "refused: only the orchestrator can spawn";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const branch = typeof input.branch === "string" ? input.branch.trim() : `work-${crypto.randomUUID().slice(0, 8)}`;
      const role = input.role === "reviewer" ? "reviewer" : "worker";
      if (!prompt || !branch) return "refused: prompt and a valid branch are required";
      if (input.taskId !== undefined && typeof input.taskId !== "string") return "refused: invalid taskId";
      if (input.baseCommit !== undefined && typeof input.taskId !== "string") return "refused: baseCommit requires a registered taskId";

      if (role === "reviewer" && input.reviewMode !== "review" && input.reviewMode !== "watch-ci") return "refused: reviewer requires reviewMode: review or watch-ci (prompt text does not select the mode)";
      if (role === "worker" && input.reviewMode !== undefined) return "refused: reviewMode is only valid for reviewer";

      if (input.baseCommit !== undefined && (role !== "worker" || typeof input.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(input.baseCommit))) return "refused: baseCommit requires worker and immutable commit";
      const attachments = await forwardImages(input.attachments, ctx);
      return withStorageLock(join(paths.runtimeProject(ctx.project), "spawn-locks", sessionId("worker", branch)), async () => {
      // One agent per branch: a reported agent may still be finishing, so wait briefly for it.
      const busy = await stillLive(runner, ctx.project, branch, wait, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (busy === null) return `refused: cannot verify whether agents are still running on ${branch}; restore liveness checks before retrying`;
      if (busy.length) return `refused: ${busy[0]} is still running on ${branch}; message it, or spawn again after it reports or exits`;

      if (input.reviewMode !== undefined && input.reviewMode !== "review" && input.reviewMode !== "watch-ci") return "refused: invalid reviewMode";
      if (typeof input.baseCommit === "string") await prepareStackSpawn(ctx.project, input.taskId as string, branch, ctx.cwd, input.baseCommit);
      return launch(runner, prompt, branch, role, input.taskId as string | undefined, { ...ctx, fresh: input.fresh === true }, attachments, role === "reviewer" ? input.reviewMode as "review" | "watch-ci" : undefined);
      });
    },
  };
}

/** Publish identity before the first transcript entry (the TUI lists transcripts). */
async function launch(runner: Runner, prompt: string, branch: string, role: "worker" | "reviewer", taskId: string | undefined, ctx: ToolContext & { fresh?: boolean }, attachments: ImageRef[] = [], reviewMode?: "review" | "watch-ci"): Promise<string> {
  const id = sessionId(role, branch);
  const run = crypto.randomUUID();
  if (taskId) await prepareTaskRun(ctx.project, taskId, branch, { id: run, agent: id, role, ...(reviewMode ? { reviewMode } : {}) });
  try {
    publishLaunch(ctx.project, id, run);
    const t = open(paths.transcript(ctx.project, id));
    if (t.head() === null) await t.append({ type: "meta", role, branch, model: "" });
    else if (ctx.fresh) await t.append({ type: "context-boundary" });
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
