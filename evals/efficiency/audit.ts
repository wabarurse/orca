/** Independently regrade retained evidence. Raw observations are never overwritten. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, grade } from "./fixtures";
import { jsonLines, claudeMetrics, codexMetrics } from "./metrics";
const input = process.argv[2] ?? join(import.meta.dir, "results/live.jsonl");
const rows = jsonLines(await Bun.file(input).text());
const temporary = await mkdtemp(join(tmpdir(), "efficiency-audit-"));
try {
  for (const [i, row] of rows.entries()) {
    const reference = join(temporary, String(i));
    const data = await fixture(reference, row.task, row.repeat + 51);
    const events = jsonLines(await Bun.file(join(row.artifacts, "stdout.jsonl")).text());
    const metrics = row.engine === "claude" ? claudeMetrics(events) : row.engine === "codex" ? codexMetrics(events) : events.at(-1);
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "cacheWriteInputTokens", "reasoningTokens", "peakInputTokens", "calls"]) {
      if (metrics[key] !== row[key]) throw new Error(`Metric mismatch ${key}: ${row.artifacts}`);
    }
    const answer = await Bun.file(join(row.artifacts, "answer.txt")).text();
    if (metrics.answer !== answer) throw new Error(`Answer mismatch: ${row.artifacts}`);
    const evidence = row.engine === "parallels" ? jsonLines(await Bun.file(join(row.artifacts, "transcript.jsonl")).text()) : events;
    const commands = new Map<string, string>();
    for (const e of evidence) {
      if (e.type === "item.completed" && e.item?.command) commands.set(e.item.id, e.item.command);
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === "tool_use" && b.name.toLowerCase() === "bash" && typeof b.input?.command === "string") commands.set(b.id, b.input.command);
      }
    }
    const shell = [...commands.values()];
    const requiredAction = row.task === "repair" ? shell.some(c => /\bbun\s+test\b/.test(c))
      : row.task === "output" ? shell.some(c => /\bbun\s+(?:\.\/)?diagnostic\.ts\b/.test(c))
      : row.task === "parallel" ? ["alpha", "beta", "gamma", "delta"].every(name => shell.some(c => {
        const probes = c.match(/\bbun\s+(?:\.\/)?(?:alpha|beta|gamma|delta)\.ts\b/g) ?? [];
        return probes.length === 1 && new RegExp(`\\bbun\\s+(?:\\./)?${name}\\.ts\\b`).test(c);
      })) : true;
    const expectedFiles = new Set<string>(), scope: string[] = [];
    for await (const file of new Bun.Glob("**/*").scan({ cwd: reference, onlyFiles: true, dot: true })) {
      expectedFiles.add(file);
      if (row.task === "repair" && file === "src/window.ts") continue;
      try { if (!Buffer.from(await Bun.file(join(reference, file)).bytes()).equals(await Bun.file(join(row.cwd, file)).bytes())) scope.push(file); }
      catch { scope.push(file); }
    }
    for await (const file of new Bun.Glob("**/*").scan({ cwd: row.cwd, onlyFiles: true, dot: true })) if (!expectedFiles.has(file)) scope.push(file);
    const correct = await grade(row.cwd, row.task, answer, data);
    if (row.engine === "parallels") {
      // Reconstruct totals directly from provider results, not the worker's aggregate.
      const usage = await Promise.all(Array.from({ length: row.requests }, async (_, n) => (await Bun.file(join(row.artifacts, `response-${n}.json`)).exists()) ? (await Bun.file(join(row.artifacts, `response-${n}.json`)).json()).usage : undefined));
      for (const [metric, key] of [["inputTokens", "input"], ["cachedInputTokens", "cachedInput"], ["outputTokens", "output"]]) {
        const total = usage.every(u => u) ? usage.reduce((n, u) => n + (u[key!] ?? 0), 0) : null;
        if (total !== row[metric!]) throw new Error(`Provider usage mismatch: ${metric}`);
      }
      const calls = await Bun.file(join(row.artifacts, "calls.json")).json();
      if (calls.length !== row.calls) throw new Error("Tool count mismatch");
      row.toolDurationSumMs = calls.reduce((n: number, c: any) => n + c.end - c.start, 0);
      row.toolSpanMs = calls.length ? Math.max(...calls.map((c: any) => c.end)) - Math.min(...calls.map((c: any) => c.start)) : 0;
    }
    row.audit = { correct, requiredAction, unexpectedChanges: scope, commands: shell, diagnosticRuns: shell.filter(c => /\bbun\s+(?:\.\/)?diagnostic\.ts\b/.test(c)).length };
    row.observedSuccess = row.success;
    row.success = row.exitCode === 0 && !row.error && correct && requiredAction && scope.length === 0;
  }
  const output = input.replace(/\.jsonl$/, ".audited.jsonl");
  await Bun.write(output, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(JSON.stringify({ trials: rows.length, passed: rows.filter(r => r.success).length, failures: rows.filter(r => !r.success).map(r => ({ arm: r.arm, task: r.task, repeat: r.repeat, error: r.error, audit: r.audit })), output }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
