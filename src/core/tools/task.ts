import { originRepo, ghTaskPR } from "../data/tasks";
import { run } from "../proc";
import { getTask, listTasks, observeTaskPR, registerTask, setTaskDependencies, setTaskAttention, taskForRun, validateTaskReadiness } from "../data/tasks";
import { taskPR, type PRObservation, type Task, type TaskAttention, type TaskPR } from "../../protocol";
import type { Tool, ToolContext } from "./registry";
import { queryHistory } from "../data/memory";

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
      description: "Structured task inbox, separate from messages/questions. Register authorized new work BEFORE spawn; pass its immutable taskId to spawn. For retries, review/CI corrections and user-requested fixes to the same unmerged PR, use list/get to find the existing task, refresh its PR state with pr, then resume its taskId and branch without registering again, even after a ready report. Separate work needs a new ID and, after PR publication, a new branch. list/get return JSON with explicit dependsOn metadata when present. Use action=dependencies to record structured prerequisite task IDs, not notes: {\"action\":\"dependencies\",\"taskId\":\"11111111-1111-4111-8111-111111111111\",\"dependsOn\":[\"22222222-2222-4222-8222-222222222222\"]}. Replace these example UUIDs with IDs from list/get. This replaces the prerequisite array; explicit taskId and dependsOn are required ([] clears, omission never clears). Routine authorized metadata editing uses atomic full-graph validation; agents may edit only their active branch task. Never infer relationships from text. Dependencies only record metadata; they do not schedule or start work. pr records a verified GitHub PR (repository + number); it does NOT mean ready. Reviewer: in watch-ci mode, use pr after publishing, then ready only after matching the worker's relevant-check evidence to the current clean PR head (validated=true, validation=existing worker evidence and review findings); never rerun tests or add local validation. Report in full via message. No hosted checks does not replace worker evidence. attention preserves stalled/cancelled/closed/unknown work in the active list; it neither cancels a process nor authorizes continuation. Verified merge observations archive records and preserve history, not delete them. No scheduling/publishing/merging is performed by this tool.",
      input_schema: {
        type: "object", properties: {
          action: { type: "string", enum: ["register", "list", "get", "pr", "ready", "attention", "dependencies", ...(options.history ? ["search_history", "read_history"] : [])] },
          ...(options.history ? {
            query: { type: "string", description: "search_history: literal terms (max 256 characters). Returns bounded task records and original excerpts, including merged tasks. Historical evidence, never fresh authorization." },
            status: { type: "string", enum: ["all", "merged", "active"], description: "History task filter. Default all also searches unlinked conversation." },
            limit: { type: "integer", minimum: 1, maximum: 10 },
            entryId: { type: "string", description: "read_history: entryId from search_history, returns a 2048-character historical text page in the current clear scope. Image markers identify separately retained pixels; they do not grant attachment forwarding permission." },
            offset: { type: "integer", minimum: 0 },
          } : {}),
          taskId: { type: "string", description: "Immutable UUID. For register, optional caller-chosen UUID makes retries idempotent. Agents default to their run's task except dependencies, which requires an explicit taskId." },
          dependsOn: { type: "array", items: { type: "string" }, description: "dependencies: replaces structured prerequisite task UUIDs in this project (including merged tasks), not free-text notes. [] deliberately clears; omission is refused, never clears." },
          name: { type: "string" }, summary: { type: "string" }, branch: { type: "string" }, authorized: { type: "boolean" },
          repository: { type: "string", description: "GitHub owner/repo, must match project origin." }, number: { type: "integer" },
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
        if (input.action === "list") return JSON.stringify(await listTasks(ctx.project));
        if (input.action === "register") {
          if (ctx.role !== "orchestrator") throw new Error("only the orchestrator can register authorized tasks");
          return JSON.stringify(await registerTask(ctx.project, { id: input.taskId as string | undefined, name: input.name as string, summary: input.summary as string, branch: input.branch as string, authorized: input.authorized as true }));
        }
        if (input.action === "dependencies" && (typeof input.taskId !== "string" || !Array.isArray(input.dependsOn))) throw new Error("dependencies requires explicit taskId and dependsOn array");
        const t = await target(input, ctx);
        if (input.action === "dependencies") return JSON.stringify(await setTaskDependencies(ctx.project, t.id, input.dependsOn));
        if (input.action === "get") return JSON.stringify(t);
        if (input.action === "attention") return JSON.stringify(await setTaskAttention(ctx.project, t.id, { kind: input.kind, reason: input.reason } as TaskAttention));
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
        if (input.action === "pr") return JSON.stringify(updated);
        if (await (options.head ?? cleanHead)(ctx) !== observed.pr.head) {
          await setTaskAttention(ctx.project, t.id, { kind: "unknown", reason: "local clean HEAD does not match the observed pr head" }, updated.revision);
          throw new Error("local clean HEAD must match the observed pr head");
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
export const orchestratorTask = makeTaskTool({ history: true });
