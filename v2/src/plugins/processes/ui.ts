// The processes plugin's TUI parts: a Processes tab (stop with s), a running count and the process tool line.
import { defineUi, type PluginUi } from "../../core/plugins";
import { getProc, listProcs, stopProc, tail, type Proc } from "./store";

const runtime = (proc: Proc): string => `${Math.round(((proc.endedAt === null ? Date.now() : Date.parse(proc.endedAt)) - Date.parse(proc.startedAt)) / 1000)}s`;
const tone = (proc: Proc): "normal" | "good" | "bad" | "warn" =>
  proc.state === "running" ? "normal" : proc.state === "exited" ? (proc.code === 0 ? "good" : "bad") : "warn";

const ui: PluginUi = defineUi({
  tabs: [{
    id: "processes",
    title: "Processes",
    chord: null,
    rows: async ctx => (await listProcs(await ctx.data("conversation"))).reverse().map(p => ({
      id: p.id, name: p.command.split("\n")[0] ?? "", status: p.state === "exited" ? `exit ${p.code ?? "?"}` : p.state,
      info: `${runtime(p)} · ${p.owner}`, tone: tone(p) })),
    details: async (row, ctx) => {
      const dir = await ctx.data("conversation");
      const proc = await getProc(dir, row.id);
      if (proc === null) return [];
      return [
        { title: "Process", lines: [proc.command, `${proc.state}${proc.code === null ? "" : ` (exit ${proc.code})`} · pid ${proc.pid} · ${runtime(proc)}`, `by ${proc.owner} in ${proc.cwd}`, `started ${proc.startedAt}`] },
        { title: "Output", lines: await tail(dir, proc.id, 40) },
      ];
    },
    actions: [{
      key: "s", label: "stop",
      run: async (row, host) => {
        if (row === null) return;
        const dir = await host.data("conversation");
        const proc = await getProc(dir, row.id);
        if (proc === null || proc.state !== "running") { host.note(`${row.id} is not running`); return; }
        if (!await host.confirm(`stop ${row.id}?`)) return;
        await stopProc(dir, proc);
        host.note(`stopped ${row.id}`);
      },
    }],
  }],
  counts: [{ id: "processes", count: async ctx => (await listProcs(await ctx.data("conversation"))).filter(p => p.state === "running").length, label: n => `${n} running` }],
  commands: [],
  toolLines: {
    process: {
      label: input => `Process(${String(input.action)}${typeof input.command === "string" ? `: ${input.command.slice(0, 50)}` : typeof input.id === "string" ? ` ${input.id}` : ""})`,
      summary: outcome => ({ summary: outcome.text.split("\n")[0] ?? "", failed: !outcome.ok || outcome.text.startsWith("refused") }),
    },
  },
  folds: {},
});

export default ui;
