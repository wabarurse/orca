import { local, type Runner } from "../runner";
import { addTask, readTasks, setStatus } from "../tasks";
import type { Tool } from "./index";

// Orchestrator-only. With `desc`, adds a task and starts a worker on a new
// branch. With `task`, starts a reviewer on that task's existing worktree.
// Both report back through the inbox.
export function makeSpawn(runner: Runner): Tool {
  return {
    spec: {
      name: "spawn",
      description:
        "Start a worker for a new task (give desc) or a reviewer for an existing one (give task). Returns the task id.",
      input_schema: {
        type: "object",
        properties: {
          desc: { type: "string", description: "What to build, with acceptance criteria. Starts a worker." },
          task: { type: "string", description: "An existing task id. Starts a reviewer on its branch." },
        },
      },
    },
    async run(input, ctx) {
      if (ctx.role !== "orchestrator") return "refused: only the orchestrator can spawn";
      const desc = typeof input.desc === "string" ? input.desc.trim() : "";
      const taskId = typeof input.task === "string" ? input.task.trim() : "";

      if (desc) {
        const task = await addTask(ctx.project, desc);
        await runner.start({ project: ctx.project, role: "worker", taskId: task.id, branch: task.branch });
        await setStatus(ctx.project, task.id, "working");
        return task.id;
      }
      if (taskId) {
        const task = (await readTasks(ctx.project)).find((t) => t.id === taskId);
        if (!task) return `refused: no task ${taskId}`;
        await runner.start({ project: ctx.project, role: "reviewer", taskId: task.id, branch: task.branch });
        await setStatus(ctx.project, task.id, "review");
        return task.id;
      }
      return "refused: give desc (new worker) or task (reviewer)";
    },
  };
}

export const spawn: Tool = makeSpawn(local);
