import { join } from "node:path";
import { jsonLines } from "./metrics";
const rows = jsonLines(await Bun.file(process.argv[2] ?? join(import.meta.dir, "results/live.audited.jsonl")).text());
const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
const median = (ns: number[]) => { const sorted = [...ns].sort((a,b) => a-b); return (sorted[Math.floor((sorted.length-1)/2)]! + sorted[Math.ceil((sorted.length-1)/2)]!)/2; };
function aggregate(rs: any[]) {
  const metric = (key: string) => rs.every(r => typeof r[key] === "number") ? mean(rs.map(r => r[key])) : null;
  const complete = rs.filter(r => typeof r.inputTokens === "number" && typeof r.cachedInputTokens === "number" && typeof r.outputTokens === "number");
  const observedInput = complete.length ? mean(complete.map(r=>r.inputTokens)) : null;
  const observedCached = complete.length ? mean(complete.map(r=>r.cachedInputTokens)) : null;
  const totalInput = metric("inputTokens"), cached = metric("cachedInputTokens");
  return { n: rs.length, passed: rs.filter(r => r.success).length, seconds: mean(rs.map(r => r.elapsedMs))/1000,
    medianSeconds: median(rs.map(r => r.elapsedMs))/1000, minSeconds: Math.min(...rs.map(r=>r.elapsedMs))/1000, maxSeconds: Math.max(...rs.map(r=>r.elapsedMs))/1000,
    input: totalInput, cached, uncached: totalInput !== null && cached !== null ? totalInput - cached : null,
    cacheHitRate: totalInput && cached !== null ? cached / totalInput : null,
    cacheWrites: metric("cacheWriteInputTokens"), output: metric("outputTokens"), peakInput: metric("peakInputTokens"), calls: metric("calls"), requests: metric("requests"),
    completeUsageTrials: complete.length, completeUsageInput: observedInput, completeUsageCached: observedCached,
    completeUsageUncached: observedInput !== null && observedCached !== null ? observedInput - observedCached : null,
    completeUsageCacheHitRate: observedInput && observedCached !== null ? observedCached / observedInput : null,
    successfulSeconds: rs.some(r=>r.success) ? mean(rs.filter(r=>r.success).map(r=>r.elapsedMs))/1000 : null,
    resultBytes: metric("resultBytes"), maxParallel: rs.map(r=>r.maxParallel ?? null), toolSpanSeconds: metric("toolSpanMs") === null ? null : metric("toolSpanMs")!/1000,
  };
}
const arms = [...new Set(rows.map(r => r.arm))];
const summarize = (rs: any[]) => Object.fromEntries(arms.map(arm => [arm, aggregate(rs.filter(r=>r.arm===arm))]));
const comparisons = Object.fromEntries(["gpt", "opus"].map(model => {
  const pairs = rows.filter(r => r.arm === `before-${model}`).map(before => {
    const after = rows.find(r => r.arm === `after-${model}` && r.task === before.task && r.repeat === before.repeat);
    return { task: before.task, repeat: before.repeat, bothPass: before.success && after?.success,
      timeRatio: after ? after.elapsedMs / before.elapsedMs : null, inputRatio: typeof after?.inputTokens === "number" && typeof before.inputTokens === "number" ? after.inputTokens / before.inputTokens : null,
      uncachedRatio: typeof after?.inputTokens === "number" && typeof before.inputTokens === "number" ? (after.inputTokens - after.cachedInputTokens) / (before.inputTokens - before.cachedInputTokens) : null };
  });
  const coding = pairs.filter(p=>p.task!=="parallel" && p.timeRatio !== null);
  return [model, { pairs, codingFasterPairs: coding.filter(p=>p.timeRatio!<1).length, codingPairs: coding.length,
    codingGeometricTimeRatio: Math.exp(mean(coding.map(p=>Math.log(p.timeRatio!)))) }];
}));
const result = { comparisons, all: summarize(rows), coding: summarize(rows.filter(r=>r.task!=="parallel")),
  tasks: Object.fromEntries([...new Set(rows.map(r=>r.task))].map(task => [task, summarize(rows.filter(r=>r.task===task))])) };
await Bun.write(process.argv[3] ?? join(import.meta.dir, "results/summary.json"), JSON.stringify(result, null, 2)+"\n");
console.log(JSON.stringify(result, null, 2));
