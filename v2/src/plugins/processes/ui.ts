import type { Result } from "../../config";
import { defineUi, type PluginContext, type PluginUi, type Tone } from "../../core/plugins";
import { settled } from "../../core/tools/registry";
import { getProc, listProcs, logFile, procLabel, stopProc, tail, type Proc } from "./store";

const runtime = (proc: Proc): string => `${Math.round(((proc.endedAt === null ? Date.now() : Date.parse(proc.endedAt)) - Date.parse(proc.startedAt)) / 1000)}s`;
const tone = (proc: Proc): Tone =>
  proc.state === "running" ? "normal" : proc.state === "exited" ? (proc.code === 0 ? "good" : "bad") : "warn";

async function procs(ctx: PluginContext): Promise<Result<Proc[]>> {
  const dir = await ctx.data("conversation");
  return dir.ok ? listProcs(dir.data, ctx) : dir;
}

async function stop(id: string, host: PluginContext, confirm: (question: string) => Promise<boolean>): Promise<string> {
  const dir = await host.data("conversation");
  if (!dir.ok) return dir.error;
  const found = await getProc(dir.data, id, host);
  if (!found.ok) return found.error;
  const proc = found.data;
  if (proc === null || proc.state !== "running") return `${id} is not running`;
  if (!await confirm(`stop ${id}?`)) return "";
  await stopProc(dir.data, proc, host);
  return `stopped ${id}`;
}

const ui: PluginUi = defineUi({
  tabs: [{
    id: "processes",
    title: "Processes",
    chord: null,
    rows: async ctx => settled(await procs(ctx)).reverse().sort((a, b) => Number(a.state !== "running") - Number(b.state !== "running")).map(p => ({
      id: p.id, name: p.command.split("\n")[0] ?? "", status: p.state === "exited" ? `exit ${p.code ?? "?"}` : p.state,
      info: `${runtime(p)} · ${p.owner}`, tone: tone(p) })),
    details: async (row, ctx) => {
      const dir = settled(await ctx.data("conversation"));
      const proc = settled(await getProc(dir, row.id, ctx));
      if (proc === null) return [];
      return [
        { title: "Process", lines: [proc.command, `${proc.state}${proc.code === null ? "" : ` (exit ${proc.code})`} · ${proc.pid === null ? `in ${proc.runner} (Enter watches)` : `pid ${proc.pid}`} · ${runtime(proc)}`, `by ${proc.owner} in ${proc.cwd}`, `started ${proc.startedAt}`] },
        { title: "Output", lines: await tail(dir, proc.id, 40) },
      ];
    },
    actions: [{
      key: "enter", label: "watch",
      run: async (row, host) => {
        if (row === null) return;
        const dir = settled(await host.data("conversation"));
        const proc = settled(await getProc(dir, row.id, host));
        if (proc === null) return;
        await host.watch({ title: proc.command.split("\n")[0] ?? proc.id, runner: proc.runner, label: procLabel(proc.id), log: logFile(dir, proc.id) });
      },
    }, {
      key: "s", label: "stop",
      run: async (row, host) => {
        if (row === null) return;
        const note = await stop(row.id, host, question => host.confirm(question));
        if (note.length > 0) host.note(note);
      },
    }],
  }],
  counts: [{ id: "processes", count: async ctx => {
    const all = await procs(ctx);
    return all.ok ? all.data.filter(p => p.state === "running").length : null;
  }, label: n => `${n} running` }],
  commands: [],
  toolLines: {
    process: {
      label: input => `Process(${String(input.action)}${typeof input.command === "string" ? `: ${input.command.slice(0, 50)}` : typeof input.id === "string" ? ` ${input.id}` : ""})`,
      summary: outcome => ({ summary: outcome.text.split("\n")[0] ?? "", failed: !outcome.ok || outcome.text.startsWith("refused") }),
    },
  },
  folds: {
    process: {
      title: n => `${n} process${n === 1 ? "" : "es"}`,
      items: (input, o) => input.action === "start" && o.ok && o.text.startsWith("started") && typeof input.command === "string" ? [input.command.slice(0, 80)] : [],
      opens: "processes",
    },
  },
});

export default ui;
