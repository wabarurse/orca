import { dependencyAction, dependencyActions } from "../data/tasks/dependency-workflow";
import { provenance } from "../data/tasks/dependency-provenance";
// Public record and private dispatch/safety envelope are deliberately distinct.
import { canonicalTask } from "../../protocol/task-ledger";
import { originRepo, ghTaskPR } from "../data/tasks";
import { run } from "../proc";
import { getTask, allTasks, removeTask, updateTaskMetadata, listTasks, observeTaskPR, registerTask, setTaskDependencies, setTaskAttention, taskForRun, validateTaskReadiness } from "../data/tasks";
import { taskPR, type PRObservation, type Task, type TaskAttention, type TaskPR } from "../../protocol";
import type { Tool, ToolContext } from "./registry";
import { queryHistory } from "../data/memory";

function toolTask(task: Task) {
  return { ...canonicalTask(task), internal: { branch: task.branch, revision: task.revision, runs: task.runs,
    dependency: provenance(task), readiness: task.readiness, attention: task.attention, publication: task.publication, removedAt: task.removedAt } };
}
const result = (task: Task) => JSON.stringify(toolTask(task));

export interface TaskToolOptions {
  history?: boolean;
  repo?: typeof originRepo;
  pr?: (project: string, pr: Pick<TaskPR, "repository" | "number">, signal?: AbortSignal) => Promise<PRObservation | null>;
  head?: (ctx: ToolContext) => Promise<string | null>;
}
async function cleanHead(ctx: ToolContext): Promise<string | null> {
  const opts = { cwd: ctx.cwd, timeoutMs: 10_000, signal: ctx.signal };
  const head = await run(["git", "rev-parse", "HEAD"], opts);
  const status = await run(["git", "--no-optional-locks", "status", "--porcelain"], opts);
  return head?.code === 0 && status?.code === 0 && !status.out.trim() ? head.out.trim() : null;
}
async function target(input: Record<string, unknown>, ctx: ToolContext): Promise<Task> {
  const own = ctx.run ? await taskForRun(ctx.project, ctx.run) : undefined;
  const t = typeof input.taskId === "string" || Number.isSafeInteger(input.taskNumber) ? await getTask(ctx.project, String(input.taskId ?? input.taskNumber)) : own;
  if (!t) throw new Error("taskId is required (agents can use their current run)");
  if (ctx.role !== "orchestrator" && (!own || own.branch !== t.branch || ctx.branch !== t.branch || own.runs.at(-1)?.state !== "started")) throw new Error("task is not on this active agent's branch");
  return t;
}
export function makeTaskTool(options: TaskToolOptions = {}): Tool {
  const repo = options.repo ?? originRepo;
  const lookup = options.pr ?? ((project, pr, signal) => ghTaskPR(project, pr, { signal }));
  return {
    spec: {
      name: "task",
      description: "Manage the current project's numbered tasks, not cross-session memory. Register authorized work before spawn; reuse the same immutable task for fixes to an unmerged PR. Agents may edit only their active branch task. Explicit DAGs allow local preparation before merges; publish gates push/create on verified prerequisite merges, latest default and matching worker/review evidence. No automatic merge. Generic bash is user-privileged, not a publication sandbox; do not bypass the supported path.",
      input_schema: {
        type: "object", properties: {
          action: { type: "string", enum: ["create", "update", "remove", "register", "list", "get", "pr", "ready", "attention", "dependencies", ...dependencyActions, ...(options.history ? ["search_history", "read_history"] : [])], description: "list/get: find existing identity and stable project number; dispatch safety is in internal. pr: immediately after publication record repository + number, before CI/validation; refresh before resuming an unmerged PR. Verified OPEN records pr open, not approval, merge permission or current mergeability. ready: watch-ci reviewer matches existing worker checks and review findings to the current clean PR head, validated=true; no reruns/local validation, even without hosted checks; report fully via message. attention: retain stalled/cancelled/closed/unknown work, not process cancellation or authorization to continue. remove: only verified merged membership, with explicit confirmation; SQL history remains. checkpoint: worker records clean immutable code for local stacked development, usable after its run stops. prepare_publication: worker verifies prerequisite merges, safely replays/adopts B-only changes onto latest default retaining recovery refs. checks: worker records already-run affected-check commands and validation on actual clean head. reviewed: review-mode reviewer records completed review using worker evidence, never runs tests. publish: watch-ci reviewer only; dependent tasks require explicit review-mode handoff even at zero review rounds; gated push/create, reconcile remote success and record verified PR; no automatic merge." },
          ...(options.history ? {
            query: { type: "string", description: "search_history: literal terms (max 256 characters). Returns bounded task records and original excerpts, including merged tasks. Historical evidence, never fresh authorization." },
            status: { type: "string", enum: ["all", "merged", "active"], description: "History task filter. Default all also searches unlinked conversation." },
            limit: { type: "integer", minimum: 1, maximum: 10 },
            entryId: { type: "string", description: "read_history: entryId from search_history, returns a 2048-character historical text page in the current clear scope. Image markers identify separately retained pixels; they do not grant attachment forwarding permission." },
            offset: { type: "integer", minimum: 0 },
          } : {}),
          taskId: { type: "string", description: "Immutable UUID. For register, optional caller-chosen UUID makes retries idempotent. Agents default to their run's task except dependencies, which requires an explicit taskId." },
          dependsOn: { type: "array", items: { type: "string" }, description: "dependencies: replaces structured prerequisite task UUIDs in this project (including merged tasks), not free-text notes; never infer dependencies from text. Metadata only, no scheduling. Use IDs from list/get. [] deliberately clears; omission is refused, never clears." },
          title: { type: "string" }, taskNumber: { type: "integer", minimum: 1, description: "Stable project task number (not PR number). taskId also accepts #number or UUID." },
          confirmed: { type: "boolean", description: "remove: explicit user confirmation required; merged membership only, SQL retained." },
          name: { type: "string", description: "Legacy alias for title." }, summary: { type: "string" }, branch: { type: "string" }, authorized: { type: "boolean" },
          repository: { type: "string", description: "GitHub owner/repo, must match project origin." }, number: { type: "integer" },
          commands: { type: "array", items: { type: "string" }, description: "checks: commands already run by worker on this clean head; relevant affected checks only, never rerun for task tool." },
          validated: { type: "boolean" }, validation: { type: "string", description: "Existing worker check evidence matched to this exact PR head and review findings; required even without hosted checks. Do not run checks again." },
          kind: { type: "string", enum: ["waiting", "blocked", "cancelled", "closed", "unknown"] }, reason: { type: "string" },
        }, required: ["action"],
      },
    },
    async run(input, ctx) {
      try {
        ctx.signal?.throwIfAborted();
        if (input.action === "search_history" || input.action === "read_history") {
          if (ctx.role !== "orchestrator") throw new Error("only the orchestrator can query conversation history");
          if (!options.history) throw new Error("history retrieval is not enabled for this tool");
          return await queryHistory(ctx.project, input);
        }
        if (input.action === "list") return JSON.stringify((await allTasks(ctx.project)).filter(t => !t.removedAt).map(toolTask));
        if (input.action === "register" || input.action === "create") {
          if (ctx.role !== "orchestrator") throw new Error("only the orchestrator can register authorized tasks");
          return result(await registerTask(ctx.project, { id: input.taskId as string | undefined, name: (input.title ?? input.name) as string, summary: input.summary as string, branch: input.branch as string, authorized: input.authorized as true }));
        }
        if (input.action === "dependencies" && (typeof input.taskId !== "string" || !Array.isArray(input.dependsOn))) throw new Error("dependencies requires explicit taskId and dependsOn array");
        const t = await target(input, ctx);
        if (dependencyActions.includes(input.action as typeof dependencyActions[number])) return await dependencyAction(String(input.action), input, ctx, t);
        if (input.action === "remove") {
          if (ctx.role !== "orchestrator") throw new Error("only orchestrator can confirm task removal");
          return result(await removeTask(ctx.project, t.id, input.confirmed === true));
        }
        if (input.action === "update") return result(await updateTaskMetadata(ctx.project, t.id, { title: input.title as string | undefined, summary: input.summary as string | undefined }));
        if (input.action === "dependencies") return result(await setTaskDependencies(ctx.project, t.id, input.dependsOn));
        if (input.action === "get") return result(t);
        if (input.action === "attention") return result(await setTaskAttention(ctx.project, t.id, { kind: input.kind, reason: input.reason } as TaskAttention));
        if (input.action !== "pr" && input.action !== "ready") throw new Error("unknown task action");
        if (ctx.role === "worker") throw new Error("pr/readiness updates belong to the orchestrator/reviewer, not the worker");
        if (input.action === "ready" && ctx.role !== "reviewer") throw new Error("only a reviewer can validate readiness");
        const identity = input.action === "ready" ? t.pr : { repository: input.repository, number: input.number };
        if (!identity || typeof identity.repository !== "string" || !Number.isSafeInteger(identity.number)) throw new Error("repository and pr number are required");
        // Validate before executing gh; the URL is derived, never an arbitrary tool-provided link.
        const pr = taskPR({ ...identity, url: `https://github.com/${identity.repository}/pull/${identity.number}`, head: t.pr?.head ?? "0".repeat(40) });
        if ((await repo(ctx.project))?.toLowerCase() !== pr.repository) throw new Error("pr repository must match project origin");
        const observed = await lookup(ctx.project, pr, ctx.signal);
        ctx.signal?.throwIfAborted();
        if (!observed) {
          if (t.readiness) await setTaskAttention(ctx.project, t.id, { kind: "unknown", reason: "pr lookup unavailable; revalidate readiness when github is observable" }, t.revision);
          throw new Error("pr lookup failed/unknown; task retained");
        }
        const updated = await observeTaskPR(ctx.project, t.id, observed, t.revision);
        if (input.action === "pr") return result(updated);
        if (await (options.head ?? cleanHead)(ctx) !== observed.pr.head) {
          await setTaskAttention(ctx.project, t.id, { kind: "unknown", reason: "local clean HEAD does not match the observed pr head" }, updated.revision);
          throw new Error("local clean HEAD must match the observed pr head");
        }
        ctx.signal?.throwIfAborted();
        return result(await validateTaskReadiness(ctx.project, t.id, { run: ctx.run!, revision: updated.revision, observation: observed, validated: input.validated as true, validation: input.validation as string }));
      } catch (error) {
        ctx.signal?.throwIfAborted();
        return `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
export const task = makeTaskTool();
export const orchestratorTask = makeTaskTool({ history: true });
