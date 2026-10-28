import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "../.."), output = process.argv[2] ? resolve(process.argv[2]!) : await mkdtemp(join(tmpdir(), "orca-adaptive-eval-"));
await mkdir(output, { recursive: true });
const cases = [
  ["adaptive-workflows", "src/core/tools/adaptive-workflow.test.ts"],
  ["files-processes-sandbox", "src/core/tools/adaptive.test.ts"],
  ["stream-fidelity", "src/providers/openai.test.ts"],
  ["provider-recovery", "src/providers/provider-recovery.test.ts"],
  ["usage-attribution", "src/providers/usage.test.ts"],
  ["delegation-ownership", "src/core/tools/spawn.test.ts"],
];
const results = [];
for (const [name, file] of cases) {
  const started = performance.now(), child = Bun.spawn([process.execPath, "test", file!], { cwd: root, env: { ...process.env, ORCA_HOME: join(output, "fallback") }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const log = join(output, `${name}.log`); await writeFile(log, stdout + stderr);
  const result = { name, code, passed: code === 0, durationMs: Math.round(performance.now() - started), log };
  results.push(result); console.log(`${name}: ${result.passed ? "PASS" : "FAIL"} (${result.durationMs}ms)`);
}
await writeFile(join(output, "results.json"), JSON.stringify({ kind: "deterministic-runtime-evaluation", results }, null, 2));
console.log(`Results: ${join(output, "results.json")}`);
if (results.some(r => !r.passed)) process.exitCode = 1;
