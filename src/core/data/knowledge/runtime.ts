import { createHash } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, BUILD_ID } from "../../../config";

export async function recordRuntime(project: string, agent: string, state: { run?: string; model: string; system: string; tools: unknown; contextTokens: number }) {
  const dir = join(paths.runtimeProject(project), "contexts"); await mkdir(dir, { recursive: true });
  const file = join(dir, `${agent}.json`), temp = `${file}.${crypto.randomUUID()}`;
  await writeFile(temp, JSON.stringify({ agent, run: state.run, pid: process.pid, build: BUILD_ID, model: state.model,
    contextTokens: state.contextTokens, updatedAt: new Date().toISOString(),
    definitionsHash: createHash("sha256").update(JSON.stringify([state.system, state.tools])).digest("hex") }), { mode: 0o600 });
  await rename(temp, file);
}
export async function runtimeContexts(project: string) {
  const dir = join(paths.runtimeProject(project), "contexts");
  const names = await readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter(n => n.endsWith(".json")).map(n => Bun.file(join(dir, n)).json()));
}
export async function usageSummary(project?: string) {
  const file = Bun.file(join(paths.runtime, "usage.jsonl"));
  const totals = { requests: 0, failed: 0, input: 0, cachedInput: 0, output: 0, durationMs: 0, usageMissing: 0, retries: 0, unattributed: 0, toolCalls: 0, toolDurationMs: 0, processRuns: 0, processDurationMs: 0, cacheWriteInput: 0, reasoning: 0, peakContext: 0 };
  if (!await file.exists()) return totals;
  let tail = "";
  const decoder = new TextDecoder();
  const add = (line: string) => {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.kind === "retry") { if (!project || row.project === project) totals.retries++; return; }
    if (row.kind === "tool") { if (!project || row.project === project) { totals.toolCalls++; totals.toolDurationMs += row.durationMs ?? 0; } return; }
    if (row.kind === "process") { if (!project || row.project === project) { totals.processRuns++; totals.processDurationMs += row.durationMs ?? 0; } return; }
    if (row.kind !== "model") return;
    if (!row.project) totals.unattributed++;
    if (project && row.project !== project) return;
    totals.peakContext = Math.max(totals.peakContext, row.contextTokens ?? row.usage?.input ?? 0);
    totals.requests++; totals.failed += row.ok ? 0 : 1; totals.durationMs += row.durationMs ?? 0;
    if (row.usage) { totals.input += row.usage.input; totals.cachedInput += row.usage.cachedInput ?? 0; totals.output += row.usage.output; totals.cacheWriteInput += row.usage.cacheWriteInput ?? 0; totals.reasoning += row.usage.reasoning ?? 0; } else totals.usageMissing++;
  };
  for await (const chunk of file.stream()) {
    const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n"); tail = lines.pop()!;
    for (const line of lines) add(line);
  }
  return { ...totals, uncachedInput: Math.max(0, totals.input - totals.cachedInput), note: "Durations may overlap; tokens measure usage, not subscription invoices. Unattributed calls include older/background requests." };
}
