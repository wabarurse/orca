import { mkdir, mkdtemp, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, arch, cpus } from "node:os";
import { createHash } from "node:crypto";
import { fixture, grade, type Task } from "./fixtures";
import { claudeMetrics, codexMetrics, jsonLines } from "./metrics";
const locations = await Bun.file(join(import.meta.dir, "results/paths.json")).json();
const system = "This is explicitly authorized local work: execute directly in this working directory. Do not delegate, spawn agents, register tasks, ask questions, create scheduled tasks, access the network, install dependencies, or make commits. Read only workspace files and tool-output artifacts explicitly returned by your tools. Use Bun for JavaScript/TypeScript. Inspect evidence and verify changes. Use concise results. Issue independent read-only tool calls together when possible; keep dependent work ordered. Return the requested final answer; if your harness delivers answers through a message tool, address it to the user.";
const arms = [
  { name: "before-gpt", engine: "parallels", model: "gpt-6-astra", after: false },
  { name: "after-gpt", engine: "parallels", model: "gpt-6-astra", after: true },
  { name: "codex-gpt", engine: "codex", model: "gpt-6-astra" },
  { name: "before-opus", engine: "parallels", model: "claude-opus-5-5", after: false },
  { name: "after-opus", engine: "parallels", model: "claude-opus-5-5", after: true },
  { name: "claude-opus", engine: "claude", model: "claude-opus-5-5" },
];
const repeats = Number(process.env.EFF_REPEATS ?? 3);
const tasks = (process.env.EFF_TASKS?.split(",") ?? ["lookup", "repair", "repository", "output", "parallel"]) as Task[];
const selected = arms.filter(a => !process.env.EFF_ARMS || process.env.EFF_ARMS.split(",").includes(a.name));
if (!selected.length || !Number.isInteger(repeats) || repeats < 1 || tasks.some(t => !["lookup", "repair", "repository", "output", "parallel"].includes(t))) throw new Error("Invalid matrix");
const output = resolve(process.env.EFF_RESULTS ?? join(import.meta.dir, "results/live.jsonl"));
if (await Bun.file(output).exists()) throw new Error("Trials are preserved. Select a fresh EFF_RESULTS file.");
await mkdir(resolve(output, ".."), { recursive: true });
const runRoot = await mkdtemp(join(locations.root, "run-"));
async function version(command: string[]) { const p = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" }); const text = (await new Response(p.stdout).text()).trim(); if (await p.exited) throw new Error(`Failed: ${command[0]}`); return text; }
await Bun.write(join(runRoot, "environment.json"), JSON.stringify({ ...locations, runRoot, system, arms: selected, tasks, repeats,
  date: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, bun: Bun.version,
  claude: await version(["claude", "--version"]), codex: await version(["codex", "--version"]),
  commit: await version(["git", "rev-parse", "HEAD"]), diff: await version(["git", "diff", "--stat"]), effort: "medium", fast: false,
}, null, 2));
async function manifest(cwd: string) {
  const out: Record<string, string> = {};
  for await (const file of new Bun.Glob("**/*").scan({ cwd, dot: true, onlyFiles: true })) out[file] = createHash("sha256").update(await Bun.file(join(cwd, file)).bytes()).digest("hex");
  return out;
}
console.log(`ARTIFACTS ${runRoot}`);
for (let repeat = 0; repeat < repeats; repeat++) for (const [taskIndex, task] of tasks.entries()) {
  const offset = (repeat + taskIndex) % selected.length;
  const rotated = [...selected.slice(offset), ...selected.slice(0, offset)];
  const order = repeat % 2 ? rotated.reverse() : rotated;
  for (const arm of order) {
    const dir = await mkdtemp(join(runRoot, "trial-")); const state = join(dir, "state"); const cwd = join(state, "projects/trial/repo"); await mkdir(cwd, { recursive: true });
    const data = await fixture(cwd, task, repeat + 51); const before = await manifest(cwd);
    const spec = { ...arm, dir, state, cwd, sourceRoot: arm.after ? locations.after : locations.baseline, prompt: data.prompt, system };
    const specPath = join(dir, "spec.json"); await Bun.write(specPath, JSON.stringify(spec));
    let argv: string[];
    if (arm.engine === "parallels") argv = [process.execPath, join(import.meta.dir, "worker.ts"), specPath];
    else if (arm.engine === "codex") argv = ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--color", "never", "--skip-git-repo-check", "-m", arm.model,
      "-c", 'model_reasoning_effort="medium"', "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "-c", "features.skip_host_skill_discovery=true", "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.hooks=false", "-c", "features.multi_agent=false",
      "-c", "suppress_unstable_features_warning=true", "-c", `developer_instructions=${JSON.stringify(system)}`, "-s", "workspace-write", data.prompt];
    else argv = ["claude", "-p", data.prompt, "--model", arm.model, "--effort", "medium", "--output-format", "stream-json", "--verbose", "--safe-mode",
      "--setting-sources", "", "--settings", '{"autoMemoryEnabled":false,"fastMode":false}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk",
      "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep", "--disallowedTools", "Task,Agent,WebSearch,WebFetch", "--append-system-prompt", system];
    await Bun.write(join(dir, "command.json"), JSON.stringify(argv, null, 2));
    console.log(`START ${repeat + 1}/${repeats} ${task} ${arm.name}`);
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.ANTHROPIC_API_KEY;
    const start = performance.now();
    const p = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: Bun.file(join(dir, "stdout.jsonl")), stderr: Bun.file(join(dir, "stderr.txt")), timeout: 210000 });
    const exitCode = await p.exited, elapsedMs = performance.now() - start;
    const events = jsonLines(await Bun.file(join(dir, "stdout.jsonl")).text());
    const metrics = arm.engine === "claude" ? claudeMetrics(events) : arm.engine === "codex" ? codexMetrics(events) : events.at(-1) ?? { error: "No worker result" };
    const after = await manifest(cwd);
    const unexpectedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => !(task === "repair" && f === "src/window.ts") && before[f] !== after[f]);
    const correct = await grade(cwd, task, metrics.answer ?? "", data);
    const { answer, ...counts } = metrics;
    await Bun.write(join(dir, "answer.txt"), answer ?? "");
    const row = { arm: arm.name, engine: arm.engine, model: arm.model, after: arm.after, effort: "medium", fast: false,
      task, repeat, ...counts, exitCode, elapsedMs, correct, unexpectedChanges,
      success: exitCode === 0 && !metrics.error && correct && unexpectedChanges.length === 0,
      artifacts: dir, cwd, environment: join(runRoot, "environment.json") };
    await appendFile(output, JSON.stringify(row) + "\n");
    console.log(JSON.stringify({ arm: row.arm, task, repeat, success: row.success, elapsedMs: Math.round(elapsedMs), inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, calls: row.calls, maxParallel: row.maxParallel, error: row.error, unexpectedChanges }));
    if ((metrics.error || exitCode !== 0) && !metrics.calls) throw new Error(`Failed before tool execution; inspect ${dir}`);
  }
}
