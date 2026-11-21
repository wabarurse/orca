// The tasks plugin's TUI parts: a Tasks tab (Ctrl+T) drawn as an outline of prerequisites, an open-task count,
// a tool line and a fold for created tasks.
import { defineUi, type PluginUi, type Row } from "../../core/plugins";
import type { Tone } from "../../core/plugins/types";
import { changeTasks, readTasks, settled, type Task, type TaskStatus } from "./store";

const tones: Record<TaskStatus, Tone> = { queued: "dim", working: "normal", waiting: "warn", "pr open": "good", merged: "good", closed: "dim" };

/** Each task under its lowest-numbered prerequisite (├─/└─, │ continuations); tasks without one are roots. */
export function outline(tasks: Task[]): Row[] {
  const known = new Set(tasks.map(t => t.number));
  const parent = (t: Task): number | null => t.dependsOn.filter(n => known.has(n)).sort((a, b) => a - b)[0] ?? null;
  const children = (of: number | null): Task[] => tasks.filter(t => parent(t) === of).sort((a, b) => a.number - b.number);
  const rows: Row[] = [];
  const walk = (task: Task, lead: string, branch: string): void => {
    const others = task.dependsOn.filter(n => n !== parent(task)).map(n => `+#${n}`);
    const info = [task.pr === null ? "" : `PR #${task.pr.number}`, ...others, task.branch ?? ""].filter(s => s.length > 0).join(" ");
    rows.push({ id: String(task.number), name: `${lead}${branch}#${task.number} ${task.name}`, status: task.status, info, tone: tones[task.status] });
    const kids = children(task.number);
    kids.forEach((kid, i) => walk(kid, branch === "" ? lead : `${lead}${branch === "└─ " ? "   " : "│  "}`, i === kids.length - 1 ? "└─ " : "├─ "));
  };
  for (const root of children(null)) walk(root, "", "");
  return rows;
}

const ui: PluginUi = defineUi({
  tabs: [{
    id: "tasks",
    title: "Tasks",
    chord: "t",
    rows: async ctx => outline(await readTasks(await ctx.data("conversation"))),
    details: async (row, ctx) => {
      const tasks = await readTasks(await ctx.data("conversation"));
      const task = tasks.find(t => String(t.number) === row.id);
      if (task === undefined) return [];
      const unblocks = tasks.filter(t => t.dependsOn.includes(task.number)).map(t => `#${t.number} ${t.name}`);
      return [
        { title: `#${task.number} ${task.name}`, lines: task.summary.length > 0 ? task.summary.split("\n") : ["(no summary)"] },
        { title: "Record", lines: [`status ${task.status}`, `branch ${task.branch ?? "none"}`, `id ${task.id}`, `created ${task.created}`, `updated ${task.updated}`] },
        { title: "Depends on", lines: [task.dependsOn.length > 0 ? task.dependsOn.map(n => `#${n}`).join(", ") : "nothing", `Unblocks: ${unblocks.length > 0 ? unblocks.join(", ") : "nothing"}`] },
        { title: "PR", lines: [task.pr === null ? "none" : `${task.pr.repo}#${task.pr.number} ${task.pr.url}`] },
        { title: "Notes", lines: task.notes.length > 0 ? task.notes : ["none"] },
      ];
    },
    actions: [{
      key: "c", label: "close",
      run: async (row, host) => {
        if (row === null || !await host.confirm(`close task #${row.id}?`)) return;
        const closed = await changeTasks(await host.data("conversation"), async tasks => {
          const task = tasks.find(t => String(t.number) === row.id);
          if (task === undefined || settled(task)) return { tasks: null, result: false };
          return { tasks: tasks.map(t => t === task ? { ...t, status: "closed" as const, updated: new Date().toISOString() } : t), result: true };
        });
        host.note(closed ? `closed task #${row.id}` : `task #${row.id} is already settled`);
      },
    }],
  }],
  counts: [{ id: "tasks", count: async ctx => (await readTasks(await ctx.data("conversation"))).filter(t => !settled(t)).length, label: n => `${n} task${n === 1 ? "" : "s"}` }],
  commands: [],
  toolLines: { task: {
    label: input => `task(${String(input.action)}${typeof input.name === "string" ? `: ${input.name.slice(0, 40)}` : input.task !== undefined ? ` #${String(input.task)}` : ""})`,
    summary: outcome => ({ summary: outcome.text.split("\n")[0] ?? "", failed: !outcome.ok || outcome.text.startsWith("refused") }),
  } },
  folds: { task: { title: n => `${n} task${n === 1 ? "" : "s"}`, items: (input, outcome) => input.action === "create" && outcome.ok && typeof input.name === "string" ? [input.name] : [], opens: "tasks" } },
});

export default ui;
