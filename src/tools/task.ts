import { originRepo, ghTaskPR } from "../github";
import { run } from "../proc";
import { getTask, listTasks, observeTaskPR, registerTask, setTaskAttention, taskForRun, taskPR, validateTaskReadiness, type PRObservation, type Task, type TaskAttention, type TaskPR } from "../tasks";
import type { Tool, ToolContext } from "./index";

export interface TaskToolOptions {
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
  const t = typeof input.taskId === "string" ? await getTask(ctx.project, input.taskId) : own;
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
      description: "Structured task inbox, separate from messages/questions. Register authorized work BEFORE spawn; pass its immutable taskId to spawn. Reuse the ID for retries/review rounds, never for a different follow-up task even on the same branch. list/get return JSON. pr records a verified GitHub PR (repository + number); it does NOT mean ready. Reviewer: in watch-ci mode, use pr after publishing, then ready only after explicit validation of the current clean PR head (validated=true, validation=local checks and review evidence), then report in full via message. No checks is not validation. attention preserves stalled/cancelled/closed/unknown work in the active list; it neither cancels a process nor authorizes continuation. Confirmed merge observations archive records, not delete them. No scheduling/publishing/merging is performed by this tool.",
      input_schema: {
        type: "object", properties: {
          action: { type: "string", enum: ["register", "list", "get", "pr", "ready", "attention"] },
          taskId: { type: "string", description: "Immutable UUID. For register, optional caller-chosen UUID makes retries idempotent. Agents default to their run's task." },
          name: { type: "string" }, summary: { type: "string" }, branch: { type: "string" }, authorized: { type: "boolean" },
          repository: { type: "string", description: "GitHub owner/repo, must match project origin." }, number: { type: "integer" },
          validated: { type: "boolean" }, validation: { type: "string", description: "Explicit local validation/review evidence for this exact PR head; required even without hosted checks." },
          kind: { type: "string", enum: ["waiting", "blocked", "cancelled", "closed", "unknown"] }, reason: { type: "string" },
        }, required: ["action"],
      },
    },
    async run(input, ctx) {
      try {
        ctx.signal?.throwIfAborted();
        if (input.action === "list") return JSON.stringify(await listTasks(ctx.project));
        if (input.action === "register") {
          if (ctx.role !== "orchestrator") throw new Error("only the orchestrator can register authorized tasks");
          return JSON.stringify(await registerTask(ctx.project, { id: input.taskId as string | undefined, name: input.name as string, summary: input.summary as string, branch: input.branch as string, authorized: input.authorized as true }));
        }
        const t = await target(input, ctx);
        if (input.action === "get") return JSON.stringify(t);
        if (input.action === "attention") return JSON.stringify(await setTaskAttention(ctx.project, t.id, { kind: input.kind, reason: input.reason } as TaskAttention));
        if (input.action !== "pr" && input.action !== "ready") throw new Error("unknown task action");
        if (ctx.role === "worker") throw new Error("PR/readiness updates belong to the orchestrator/reviewer, not the worker");
        if (input.action === "ready" && ctx.role !== "reviewer") throw new Error("only a reviewer can validate readiness");
        const identity = input.action === "ready" ? t.pr : { repository: input.repository, number: input.number };
        if (!identity || typeof identity.repository !== "string" || !Number.isSafeInteger(identity.number)) throw new Error("repository and PR number are required");
        // Validate before executing gh; the URL is derived, never an arbitrary tool-provided link.
        const pr = taskPR({ ...identity, url: `https://github.com/${identity.repository}/pull/${identity.number}`, head: t.pr?.head ?? "0".repeat(40) });
        if ((await repo(ctx.project))?.toLowerCase() !== pr.repository) throw new Error("PR repository must match project origin");
        const observed = await lookup(ctx.project, pr, ctx.signal);
        ctx.signal?.throwIfAborted();
        if (!observed) {
          if (t.readiness) await setTaskAttention(ctx.project, t.id, { kind: "unknown", reason: "PR lookup unavailable; revalidate readiness when GitHub is observable" }, t.revision);
          throw new Error("PR lookup failed/unknown; task retained");
        }
        const updated = await observeTaskPR(ctx.project, t.id, observed, t.revision);
        if (input.action === "pr") return JSON.stringify(updated);
        if (await (options.head ?? cleanHead)(ctx) !== observed.pr.head) {
          await setTaskAttention(ctx.project, t.id, { kind: "unknown", reason: "Local clean HEAD does not match the observed PR head" }, updated.revision);
          throw new Error("local clean HEAD must match the observed PR head");
        }
        ctx.signal?.throwIfAborted();
        return JSON.stringify(await validateTaskReadiness(ctx.project, t.id, { run: ctx.run!, revision: updated.revision, observation: observed, validated: input.validated as true, validation: input.validation as string }));
      } catch (error) {
        ctx.signal?.throwIfAborted();
        return `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
export const task = makeTaskTool();
