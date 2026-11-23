import { join } from "node:path";
import { z } from "zod";
import { errorMessage, parseJson, type Result } from "../../config";
import { definePlugin, type AfterTool, type Plugin } from "../../core/plugins";
import type { ToolContext } from "../../core/tools/registry";
import { taskRetention } from "./retention";
import { changeTasks, openForBranch, parseStatus, readTasks, statuses, taskLine, wouldCycle, type Task, type TaskChange, type TaskStatus } from "./store";

export type GhResult = { code: number; stdout: string; stderr: string };
export const gh = {
  run: async (args: string[], signal: AbortSignal | null): Promise<GhResult> => {
    try {
      const proc = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(signal === null ? {} : { signal }) });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: errorMessage(error) };
    }
  },
};

const PullRequest = z.object({ state: z.string(), url: z.string(), headRefName: z.string() });
const said = (result: Result<string>): string => result.ok ? result.data : `refused: ${result.error}`;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const now = (): string => new Date().toISOString();
const text = (v: unknown): string => typeof v === "string" ? v.trim() : "";

function numberOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(/^#/, "")) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function target(tasks: Task[], input: Record<string, unknown>, ctx: ToolContext): Task | string {
  const n = numberOf(input.task);
  const task = n !== null ? tasks.find(t => t.number === n) : ctx.branch !== null ? openForBranch(tasks, ctx.branch) ?? undefined : undefined;
  if (task === undefined) return n === null ? "refused: name the task (task: 3)" : `refused: no task #${n}`;
  if (ctx.role !== "orchestrator" && task.branch !== ctx.branch) return `refused: #${task.number} is not this branch's task`;
  return task;
}

function dependencies(tasks: Task[], self: number, raw: unknown): number[] | string {
  if (!Array.isArray(raw)) return "refused: depends_on is a list of task numbers";
  const deps = raw.map(numberOf).filter((n): n is number => n !== null && n !== self && tasks.some(t => t.number === n));
  if (deps.length !== raw.length) return "refused: depends_on names an unknown task or the task itself";
  const unique = [...new Set(deps)];
  return wouldCycle(tasks, self, unique) ? "refused: depends_on would make a cycle" : unique;
}

async function create(dir: string, input: Record<string, unknown>): Promise<string> {
  const name = text(input.name);
  if (name.length === 0) return "refused: a task needs a name";
  return said(await changeTasks(dir, async (tasks): Promise<TaskChange<string>> => {
    const number = tasks.reduce((max, t) => Math.max(max, t.number), 0) + 1;
    const deps = input.depends_on === undefined ? [] : dependencies(tasks, number, input.depends_on);
    if (typeof deps === "string") return { tasks: null, result: deps };
    const branch = text(input.branch);
    const at = now();
    const task: Task = { number, id: crypto.randomUUID(), name, summary: text(input.summary), branch: branch.length > 0 ? branch : null,
      status: "queued", pr: null, dependsOn: deps, created: at, updated: at, notes: [] };
    return { tasks: [...tasks, task], result: `created ${taskLine(task)}` };
  }));
}

async function update(dir: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  return said(await changeTasks(dir, async (tasks): Promise<TaskChange<string>> => {
    const task = target(tasks, input, ctx);
    if (typeof task === "string") return { tasks: null, result: task };
    const next: Task = { ...task, updated: now() };
    if (input.status !== undefined) {
      const status = parseStatus(input.status);
      if (status === null) return { tasks: null, result: `refused: status is one of ${statuses.join(", ")}` };
      next.status = status;
    }
    if (input.summary !== undefined) next.summary = text(input.summary);
    if (text(input.notes).length > 0) next.notes = [...task.notes, `${next.updated.slice(0, 16)} ${ctx.agent}: ${text(input.notes)}`];
    if (input.depends_on !== undefined) {
      const deps = dependencies(tasks, task.number, input.depends_on);
      if (typeof deps === "string") return { tasks: null, result: deps };
      next.dependsOn = deps;
    }
    return { tasks: tasks.map(t => t.number === task.number ? next : t), result: `updated ${taskLine(next)}` };
  }));
}

async function linkPR(dir: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repo = text(input.repository), number = numberOf(input.number);
  if (!REPO.test(repo) || number === null) return "refused: pr needs repository (owner/repo) and number";
  const current = await readTasks(dir);
  if (!current.ok) return `refused: ${current.error}`;
  const before = target(current.data, input, ctx);
  if (typeof before === "string") return before;
  const view = await gh.run(["pr", "view", String(number), "--repo", repo, "--json", "state,url,headRefName"], ctx.signal);
  if (view.code !== 0) return `refused: gh pr view failed: ${view.stderr.trim().split("\n")[0] ?? `exit ${view.code}`}`;
  const json = parseJson(view.stdout);
  const parsed = json.ok ? PullRequest.safeParse(json.data) : null;
  if (parsed === null || !parsed.success) return "refused: gh pr view printed no PR JSON";
  const pr = parsed.data;
  if (before.branch !== null && pr.headRefName !== before.branch) return `refused: PR #${number} is on ${pr.headRefName}, task #${before.number} on ${before.branch}`;
  const status: TaskStatus = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "pr open";
  return said(await changeTasks(dir, async (tasks): Promise<TaskChange<string>> => {
    const task = tasks.find(t => t.number === before.number);
    if (task === undefined) return { tasks: null, result: `refused: no task #${before.number}` };
    const next: Task = { ...task, branch: task.branch ?? pr.headRefName, pr: { repo, number, url: pr.url }, status, updated: now() };
    return { tasks: tasks.map(t => t.number === task.number ? next : t), result: `linked ${taskLine(next)}` };
  }));
}

async function close(dir: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  return update(dir, { ...input, status: "closed" }, ctx);
}

export const onSpawn: AfterTool = async (call, result, ctx) => {
  if (call.name !== "subagent" || call.input.action !== "spawn" || !result.ok || ctx.role !== "orchestrator") return result;
  const branch = text(call.input.branch);
  if (branch.length === 0) return result;
  const name = (text(call.input.brief).split("\n").find(l => l.trim().length > 0) ?? branch).trim().replace(/^#+\s*/, "").slice(0, 80);
  const dir = await ctx.data("conversation");
  const recorded = dir.ok ? await changeTasks(dir.data, async (tasks): Promise<TaskChange<null>> => {
    const open = openForBranch(tasks, branch);
    const at = now();
    const working: TaskStatus = "working";
    if (open !== null) return { tasks: open.status === working ? null : tasks.map(t => t === open ? { ...t, status: working, updated: at } : t), result: null };
    const number = tasks.reduce((max, t) => Math.max(max, t.number), 0) + 1;
    return { tasks: [...tasks, { number, id: crypto.randomUUID(), name, summary: "", branch, status: working, pr: null, dependsOn: [], created: at, updated: at, notes: [] }], result: null };
  }) : dir;
  if (recorded.ok) return result;
  const note = `\n(tasks: could not record the task: ${recorded.error})`;
  return { ok: true, content: typeof result.content === "string" ? result.content + note : [...result.content, { type: "text", text: note }] };
};

const plugin: Plugin = definePlugin({
  name: "tasks",
  description: "Tasks: the conversation's assignments as numbered tasks with status, branch, PR link and prerequisites.",
  tools: [{
    roles: ["orchestrator", "worker", "reviewer"],
    replaces: false,
    tool: {
      parallel: input => input.action === "list",
      spec: { name: "task", description: "Track this conversation's assignments as numbered tasks. create (orchestrator): name, summary, branch, depends_on. list: every task. update: status (queued, working, waiting, pr open, merged, closed), summary, notes (appended), depends_on. pr: link a published PR by repository (owner/repo) and number; it is verified with gh. close (orchestrator): settle a task that will not merge. Workers and reviewers may update and link a PR only for their own branch's task; task defaults to it. A spawn registers its branch's task on its own.",
        input_schema: { type: "object", properties: {
          action: { type: "string", enum: ["create", "list", "update", "pr", "close"] },
          task: { type: "integer", description: "update, pr, close: the task number." },
          name: { type: "string" },
          summary: { type: "string" },
          branch: { type: "string" },
          status: { type: "string", enum: [...statuses] },
          notes: { type: "string" },
          depends_on: { type: "array", items: { type: "integer" } },
          repository: { type: "string", description: "pr: owner/repo." },
          number: { type: "integer", description: "pr: the PR number." },
        }, required: ["action"] } },
      async run(input, ctx) {
        const dir = join(ctx.data, "tasks");
        if (input.action === "list") {
          const tasks = await readTasks(dir);
          if (!tasks.ok) return `refused: ${tasks.error}`;
          return tasks.data.length === 0 ? "no tasks" : tasks.data.map(taskLine).join("\n");
        }
        if ((input.action === "create" || input.action === "close") && ctx.role !== "orchestrator") return `refused: only the orchestrator can ${input.action} tasks`;
        if (input.action === "create") return create(dir, input);
        if (input.action === "update") return update(dir, input, ctx);
        if (input.action === "pr") return linkPR(dir, input, ctx);
        if (input.action === "close") return close(dir, input, ctx);
        return `refused: unknown action ${String(input.action)}`;
      },
    },
  }],
  prompt: [{ role: "orchestrator", text: "Every assignment is a task: create it with task (a spawn registers its branch on its own), keep its status current, and link each PR with task pr right after it is created." }],
  skills: [],
  storage: [{ scope: "conversation", about: "tasks/tasks.json: the numbered tasks with status, branch, PR link and prerequisites" }],
  hooks: { beforeTool: [], afterTool: [onSpawn], beforeRequest: [], onInput: [] },
  bundles: [],
  retention: [taskRetention],
  provides: [],
  uses: [],
  emits: [],
  on: [],
  guard: [],
  ui: "./ui.ts",
  background: "./background.ts",
});

export default plugin;
