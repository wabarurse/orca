import { prepareStackSpawn } from "../data/tasks";
import { attachmentSchema, forwardImages } from "./attachments";
import { consume, content, pending, put } from "../data/inbox";
import { imageContent } from "../data/images";
import type { ImageRef } from "../../protocol";
import { delay, launchIdentity, publishLaunch, readRun } from "../tmux";
import { getTask, invalidateTaskBranch, prepareTaskRun, stopTaskRun, taskForRun } from "../data/tasks";
import { paths } from "../../config";
import { local, sessionId, type Runner } from "../tmux";
import { open } from "../data/transcripts";
import type { Tool, ToolContext } from "./registry";
import { withStorageLock } from "../data";
import { join } from "node:path";
import { execution } from "../data/projects/lifecycle";

// Orchestrator-only. Seeds the agent's transcript with the prompt, then starts
// it in a worktree on `branch`. Spawning again on the same branch and role
// appends to that transcript, so a second review round keeps its context,
// and a worker given a follow-up task on its open branch keeps its own. When
// that agent is still live (for example a reported worker supervising a dev
// server), the prompt goes to its inbox instead and the same run continues. The
// description holds the orchestrator's reuse-or-new-branch rule.
/** How long spawn waits for a live agent on the branch to finish, and how often it looks. */
export interface SpawnWait { waitMs: number; pollMs: number }
const WAIT: SpawnWait = { waitMs: 20_000, pollMs: 250 };

/** A reported agent with no background commands to supervise is about to exit: wait for it rather than deliver. */
async function finishing(project: string, id: string): Promise<boolean> {
  const s = await readRun(project, id);
  return !!s && s.run === launchIdentity(project, id) && s.state === "reported" && s.step !== "waiting for background commands";
}

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

type ReviewMode = "review" | "watch-ci";
/** Spawn input after its refusal checks: `reviewMode` is the validated mode (undefined for a worker). */
type Checked = Record<string, unknown> & { reviewMode?: ReviewMode };

export function makeSpawn(runner: Runner, wait: SpawnWait = WAIT): Tool {
  return {
    spec: {
      name: "spawn",
      description: "Delegate an outcome whose intermediate work would grow coordinator context: many reads, long outputs or repeated trials/checks, regardless of task type. Keep bounded actions with short results direct when delegation adds overhead. This does not authorize commit, review, publication or CI. New work starts with a fresh brief, not the orchestrator transcript. Branch is optional: a new work branch is allocated if omitted. Reuse an existing branch for feedback on the same unmerged result. If that branch's agent of the same role is still live (even after reporting, e.g. supervising a dev server), the prompt is delivered to its inbox and it continues in its current run; no new agent starts. Set fresh=true to reset only the idle worker's model context while retaining workspace and full history. taskId is optional for ordinary work and required for tracked publication/dependencies. Reviewer role is an explicit independent assessment, not an automatic next stage. Never reuse a merged branch.",
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
      const epoch = ctx.executionEpoch ?? execution.epoch(ctx.project);
      execution.assertActive(ctx.project, epoch);
      ctx = { ...ctx, executionEpoch: epoch };
      if (ctx.role !== "orchestrator") return "refused: only the orchestrator can spawn";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const branch = typeof input.branch === "string" ? input.branch.trim() : `work-${crypto.randomUUID().slice(0, 8)}`;
      const role = input.role === "reviewer" ? "reviewer" : "worker";
      if (!prompt || !branch) return "refused: prompt and a valid branch are required";
      if (input.taskId !== undefined && typeof input.taskId !== "string") return "refused: invalid taskId";
      if (input.baseCommit !== undefined && typeof input.taskId !== "string") return "refused: baseCommit requires a registered taskId";

      // Every input refusal comes before any liveness check, delivery or launch; both use only the checked reviewMode.
      if (role === "reviewer" && input.reviewMode !== "review" && input.reviewMode !== "watch-ci") return "refused: reviewer requires reviewMode: review or watch-ci (prompt text does not select the mode)";
      if (role === "worker" && input.reviewMode !== undefined) return "refused: reviewMode is only valid for reviewer";
      const reviewMode = role === "reviewer" ? input.reviewMode as ReviewMode : undefined;

      if (input.baseCommit !== undefined && (role !== "worker" || typeof input.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(input.baseCommit))) return "refused: baseCommit requires worker and immutable commit";
      const attachments = await forwardImages(input.attachments, ctx);
      const checked: Checked = { ...input, reviewMode };
      return withStorageLock(join(paths.runtimeProject(ctx.project), "spawn-locks", sessionId("worker", branch)), async () => {
      // One agent per branch. A live agent of the same role takes the prompt in its
      // inbox at once; anything else (another role, an agent finishing its last
      // report) gets the brief wait, after which a same-role survivor still takes it.
      const id = sessionId(role, branch);
      const unverified = `refused: cannot verify whether agents are still running on ${branch}; restore liveness checks before retrying`;
      const now = await runner.running(ctx.project, [sessionId("worker", branch), sessionId("reviewer", branch)], ctx.signal).catch(() => null);
      ctx.signal?.throwIfAborted();
      if (now === null) return unverified;
      const receptive = now.length === 1 && now[0] === id && !await finishing(ctx.project, id);
      const busy = !now.length || receptive ? now : await stillLive(runner, ctx.project, branch, wait, ctx.signal);
      ctx.signal?.throwIfAborted();
      if (busy === null) return unverified;
      execution.assertActive(ctx.project, epoch);
      const other = busy.find(agent => agent !== id);
      if (other) return `refused: ${other} is still running on ${branch} and one agent works on a branch at a time, so this ${role} prompt was not delivered; message ${other} instead, or spawn the ${role} again after ${other} reports and exits`;
      if (busy.length) return deliver(runner, id, prompt, branch, role, checked, ctx, attachments);

      if (typeof input.baseCommit === "string") await prepareStackSpawn(ctx.project, input.taskId as string, branch, ctx.cwd, input.baseCommit);
      return launch(runner, prompt, branch, role, input.taskId as string | undefined, { ...ctx, executionEpoch: epoch, fresh: input.fresh === true }, attachments, reviewMode);
      });
    },
  };
}

/**
 * Hand `prompt` to the live same-role agent `id` through its inbox: its current
 * run (and task run) continues and reads it at its next inbox check. Refused when
 * that would be unsafe: fresh context, a new stacked base, a different task or
 * review mode. An agent that exited before reading it is started again with the
 * queued prompt, so it is never left unread.
 */
async function deliver(runner: Runner, id: string, prompt: string, branch: string, role: "worker" | "reviewer", input: Checked, ctx: ToolContext, attachments: ImageRef[]): Promise<string> {
  const wait = `wait for ${id} to report and exit (it exits once its background commands end: stop them with process, or message it), then spawn again`;
  if (input.fresh === true) return `refused: fresh=true needs an idle ${role}, but ${id} is still running on ${branch}; spawn again without fresh to deliver this prompt into its current context, or ${wait} with fresh=true`;
  if (input.baseCommit !== undefined) return `refused: baseCommit is only for a new branch, but ${id} is already running on ${branch}; spawn again without baseCommit to deliver this prompt to it`;
  const run = launchIdentity(ctx.project, id);
  const task = run ? await taskForRun(ctx.project, run) : undefined;
  const label = (t: { id: string; number?: number }) => t.number ? `task #${t.number} (${t.id})` : `task ${t.id}`;
  const current = task ? label(task) : "no registered task";
  if (typeof input.taskId === "string") {
    const wanted = await getTask(ctx.project, input.taskId).catch(() => undefined);
    if (!wanted) return `refused: task ${input.taskId} was not found; use task list/get for its ID. ${id} is running on ${branch} for ${current}`;
    if (wanted.archive) return `refused: ${label(wanted)} is archived (its PR merged); never reuse a merged branch, register new work on a new branch`;
    if (wanted.id !== task?.id) return `refused: ${id} is running on ${branch} for ${current}, not ${label(wanted)}; a running agent keeps its task. Spawn again with ${task ? `taskId ${task.id}` : "no taskId"} to deliver this prompt to it, or ${wait} with taskId ${wanted.id}`;
  }
  const mode = task?.runs.at(-1)?.reviewMode;
  if (role === "reviewer" && mode && mode !== input.reviewMode) return `refused: ${id} is running in ${mode} mode on ${branch}, not ${String(input.reviewMode)}; spawn again with reviewMode ${mode} to deliver this prompt to it, or ${wait} with reviewMode ${String(input.reviewMode)}`;
  await put(ctx.project, id, { from: "orchestrator", text: prompt, ...(attachments.length ? { attachments } : {}) });
  // New instructions can change the branch: earlier readiness no longer holds (the agent repeats this when it reads them).
  if (run) await invalidateTaskBranch(ctx.project, run);
  const after = await runner.running(ctx.project, [id], ctx.signal).catch(() => null);
  if (after && !after.includes(id) && await pending(ctx.project, id)) {
    const taskId = typeof input.taskId === "string" ? input.taskId : task && !task.archive ? task.id : undefined;
    const started = await launch(runner, null, branch, role, taskId, ctx, [], input.reviewMode);
    return `${started}: it exited before reading the prompt, so it was started again on ${branch} with the prompt queued`;
  }
  return `delivered to running ${id}; it continues on ${branch} in its current run (${current}) and reads the prompt at its next inbox check. No new agent was started; its report arrives in your inbox.`;
}

/** Publish identity before the first transcript entry (the TUI lists transcripts). A null prompt starts it on its queued inbox alone. */
async function launch(runner: Runner, prompt: string | null, branch: string, role: "worker" | "reviewer", taskId: string | undefined, ctx: ToolContext & { fresh?: boolean }, attachments: ImageRef[] = [], reviewMode?: ReviewMode): Promise<string> {
  const id = sessionId(role, branch);
  const run = crypto.randomUUID();
  if (taskId) await prepareTaskRun(ctx.project, taskId, branch, { id: run, agent: id, role, ...(reviewMode ? { reviewMode } : {}) });
  try {
    execution.assertActive(ctx.project, ctx.executionEpoch);
    publishLaunch(ctx.project, id, run, ctx.executionEpoch);
    const t = open(paths.transcript(ctx.project, id));
    if (t.head() === null) await t.append({ type: "meta", role, branch, model: "" });
    else if (ctx.fresh) await t.append({ type: "context-boundary" });
    await consume(ctx.project, id, t, async inbox => {
      ctx.signal?.throwIfAborted();
      const queued = content(inbox);
      const next = prompt === null ? null : imageContent(`Branch: ${branch}\n\n${prompt}`, attachments);
      // One durable entry: never acknowledge STOP without also preserving its
      // position before this explicit instruction. No text/timestamp inference.
      const blocks = (value: typeof queued) => typeof value === "string" ? [{ type: "text" as const, text: value }] : value;
      if (!inbox.length && next === null) return;
      await t.append({ type: "message", inbox, message: { role: "user",
        content: !inbox.length ? next! : next === null ? queued : [...blocks(queued), ...blocks(next)] } }, ctx.signal);
    }, true);
    ctx.signal?.throwIfAborted();
    execution.assertActive(ctx.project, ctx.executionEpoch);
    await runner.start({ project: ctx.project, role, branch, run, executionEpoch: ctx.executionEpoch, ...(ctx.signal ? { signal: ctx.signal } : {}) });
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
