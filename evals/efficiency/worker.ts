/** Real production orchestrator; only credentials, measurements and benchmark isolation are injected. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { provider as accountProvider } from "../../src/login/accounts";
import { providerFor, type Provider, type Turn } from "../../src/providers";
import type { Tool } from "../../src/core/tools";
import { paths } from "../../src/config/config";
import { legacy } from "../../src/config/legacy";
const spec = await Bun.file(process.argv[2]!).json();
// Resolve the configured subscription before switching to a disposable project store.
// Both arms share the instrumented adapter. Cache off reproduces the baseline request payload.
const authHome = paths.root;
// Frozen baseline checkouts still read the old variable. Isolate both versions.
const useState = (root: string) => { process.env.ORCA_HOME = root; process.env[legacy.homeVariable] = root; };
const source = await accountProvider(providerFor(spec.model), { promptCache: spec.after === true });
useState(spec.state);
await mkdir(spec.state, { recursive: true });
await Bun.write(join(spec.state, "config.toml"), `model = ${JSON.stringify(spec.model)}\n`);
const project = "trial", projectRoot = join(spec.state, "projects", project);
await Bun.write(join(projectRoot, "model-settings.json"), JSON.stringify({ [spec.model]: { effort: "medium", fast: false } }));
const { createOrchestrator } = await import(join(spec.sourceRoot, "src/core/agent-loop/orc/orchestrator.ts"));
const { registry, toolsFor } = await import(join(spec.sourceRoot, "src/core/tools/index.ts"));
const requests: any[] = [], calls: any[] = [];
let active = 0, maxParallel = 0, resultBytes = 0, streamed = "";
const started = performance.now();
const wrapped: Provider = { ...source, async complete(req) {
  if (requests.length >= 30) throw new Error("Evaluation request limit reached");
  // Only the separately labelled direct-repair calibration overrides role policy.
  if (spec.directSystem) req = { ...req, system: [req.system, spec.directSystem].filter(Boolean).join("\n\n") };
  const index = requests.length, row: any = { start: performance.now() - started };
  requests.push(row);
  await Bun.write(join(spec.dir, `request-${index}.json`), JSON.stringify(req));
  try {
    // The production auth refreshers read their root lazily. Only the model phase
    // uses the real auth root; tools/inbox/transcripts always use disposable state.
    useState(authHome);
    let result: Turn;
    try { result = await source.complete(req); }
    finally { useState(spec.state); }
    row.usage = result.usage;
    await Bun.write(join(spec.dir, `response-${index}.json`), JSON.stringify(result));
    // The old OpenAI adapter did not feed observed input into context budgeting.
    if (!spec.after && source.name === "openai") return { ...result, inputTokens: undefined };
    return result;
  } catch (e) { row.error = String(e); throw e; }
  finally { row.ms = performance.now() - started - row.start; }
} };
const tools: Record<string, Tool> = {};
for (const name of toolsFor.orchestrator) {
  const tool = registry[name] as Tool;
  tools[name] = { ...tool, async run(input, ctx) {
    const row: any = { name, input, start: performance.now() - started }; calls.push(row);
    active++; maxParallel = Math.max(maxParallel, active);
    try {
      if (!["bash", "message"].includes(name) || (name === "message" && input.to !== "user")) throw new Error("Evaluation scope: work directly with local files; no delegation, registration, questions, or external access.");
      const output = await tool.run(input, ctx); resultBytes += Buffer.byteLength(output); row.output = output; return output;
    } catch (e) { row.error = String(e); throw e; }
    finally { row.end = performance.now() - started; active--; }
  } };
}
const orchestrator = await createOrchestrator({ project, provider: wrapped, tools, write: (text: string, plain?: boolean) => { if (!plain) streamed += text; } });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; orchestrator.cancel(); }, 180000);
let error: string | undefined, replies: any[] = [];
try { await orchestrator.say(spec.system + "\n\n" + spec.prompt); replies = await orchestrator.turn(); }
catch (e) { error = String(e); }
finally { clearTimeout(timer); }
if (timedOut) error = "Evaluation time limit reached";
const answer = replies.length ? replies.map(r => r.text).join("\n") : streamed.trim();
const hasUsage = requests.length > 0 && requests.every(r => r.usage);
const sum = (key: string) => hasUsage ? requests.reduce((n, r) => n + (r.usage[key] ?? 0), 0) : null;
const transcript = join(projectRoot, "transcripts/orchestrator.jsonl");
await Bun.write(join(spec.dir, "calls.json"), JSON.stringify(calls, null, 2));
await Bun.write(join(spec.dir, "transcript.jsonl"), await Bun.file(transcript).bytes());
console.log(JSON.stringify({ answer, error, inputTokens: sum("input"), cachedInputTokens: sum("cachedInput"),
  cacheWriteInputTokens: requests.every(r => r.usage?.cacheWriteInput !== undefined) ? sum("cacheWriteInput") : null,
  outputTokens: sum("output"), reasoningTokens: requests.every(r => r.usage?.reasoning !== undefined) ? sum("reasoning") : null,
  peakInputTokens: hasUsage ? Math.max(...requests.map(r => r.usage.input)) : null, requests: requests.length, calls: calls.length,
  maxParallel, resultBytes, modelMs: requests.reduce((n, r) => n + r.ms, 0), requestMetrics: requests,
  actualModels: [spec.model], permissionDenials: [], transcript, productionOrchestrator: true,
}));
