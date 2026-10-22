import { mkdir } from "node:fs/promises";
import { join } from "node:path";
export type Task = "lookup" | "repair" | "output" | "repository" | "parallel";
export async function fixture(root: string, task: Task, seed: number) {
  await mkdir(join(root, "src"), { recursive: true });
  if (task === "parallel") {
    for (const name of ["alpha", "beta", "gamma", "delta"]) await Bun.write(join(root, `${name}.ts`),
      `// Simulated independent service health probe; controlled I/O waiting workload.\nawait Bun.sleep(2000);\nconsole.log(JSON.stringify({service:${JSON.stringify(name)},status:"healthy"}));\n`);
    return { tests: "", expected: { alpha: "healthy", beta: "healthy", gamma: "healthy", delta: "healthy" },
      prompt: "Run bun alpha.ts, bun beta.ts, bun gamma.ts, and bun delta.ts to check four independent services. Run each command in its own tool call; do not combine commands or create a wrapper script. They are read-only and have no dependencies, so issue them together when possible. Return only JSON mapping each service name to its status. Do not modify files." };
  }
  if (task === "repository") {
    for (const file of ["src/compaction.ts", "src/config.ts", "src/tools/web-search.ts", "src/providers/web-search.ts"]) {
      const proc = Bun.spawn(["git", "show", `da5cc7405944ef253dbe6c95f8a3e564cf6e5a71:${file}`], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      if (await proc.exited !== 0) throw new Error("baseline source unavailable");
      await Bun.write(join(root, file), text);
    }
    return { expected: { summaryWords: 600, summaryOutputCap: 4096, recentTailCap: 8000, toolResultBytes: 16384, searchTimeoutMs: 60000, searchMaxResults: 10 }, tests: "",
      prompt: "Inspect this snapshot of the Parallels harness. Return only JSON with numeric values for: summaryWords (requested word limit), summaryOutputCap (summary-specific maximum output tokens), recentTailCap (maximum recent-tail estimate), toolResultBytes (default tool result byte cap), searchTimeoutMs, searchMaxResults (largest allowed user request). Read the implementation; do not modify files." };
  }
  const expected: Record<string, number> = {};
  for (let i = 0; i < 24; i++) {
    const value = 1000 + seed * 31 + i * 17;
    const tag = ["payments", "notifications", "uploads"][i];
    const noise = Array.from({ length: 420 }, (_, j) => `// diagnostic entry ${j}: component ${i} uses the common deployment policy.`);
    noise.splice(130 + i * 7, 0, `export const serviceName = ${JSON.stringify(tag ?? `internal-${i}`)};`, `export const requestTimeoutMs = ${value};`);
    await Bun.write(join(root, "src", `component-${i}.ts`), noise.join("\n") + "\n");
    if (tag) expected[tag] = value;
  }
  const implementation = 'export function windowOf<T>(items: T[], start: number, count: number): T[] {\n  if (start < 0 || count < 0) throw new Error("negative window");\n  return items.slice(start, start + count - 1);\n}\n';
  await Bun.write(join(root, "src/window.ts"), implementation);
  const tests = 'import {test,expect} from "bun:test";\nimport {windowOf} from "./src/window";\ntest("window contract",()=>{expect(windowOf([1,2,3,4],1,2)).toEqual([2,3]);expect(windowOf([1,2,3],0,0)).toEqual([]);expect(windowOf([1,2],1,10)).toEqual([2]);});\n';
  await Bun.write(join(root, "window.test.ts"), tests);
  await Bun.write(join(root, "diagnostic.ts"), 'for(let i=0;i<2400;i++) console.log(i===1200 ? "FAULT E_POLICY_MISSING path=src/component-17.ts" : `diagnostic ${i}: completed routine check successfully`);\n');
  return {
    expected, tests,
    prompt: task === "lookup"
      ? 'Inspect this repository. Find requestTimeoutMs for the services whose serviceName is payments, notifications, and uploads. Return only a JSON object mapping those three service names to their numeric timeouts. Do not modify files.'
      : task === "repair"
      ? 'Fix windowOf so it returns count items starting at start, correctly handles count=0 and windows extending past the end, and retains the negative-argument check. Inspect the implementation and tests, change only src/window.ts, and run the existing tests. End with a brief result.'
      : 'Run bun diagnostic.ts to collect the diagnostics. Find the FAULT entry in its output and return only JSON with keys code and path. Do not modify files.',
  };
}
export async function grade(root: string, task: Task, answer: string, data: Awaited<ReturnType<typeof fixture>>) {
  if (task === "repair") {
    const untouched = await Bun.file(join(root, "window.test.ts")).text() === data.tests;
    const code = 'import {windowOf} from "./src/window"; for(let n=0;n<8;n++) for(let s=0;s<10;s++) for(let c=0;c<10;c++){const a=Array.from({length:n},(_,i)=>i); if(JSON.stringify(windowOf(a,s,c))!==JSON.stringify(a.slice(s,s+c)))process.exit(1);} for(const args of [[-1,2],[0,-1]]){let threw=false;try{windowOf([],args[0],args[1])}catch{threw=true}if(!threw)process.exit(1);}';
    const p = Bun.spawn([process.execPath, "-e", code], { cwd: root, stdout: "ignore", stderr: "ignore", timeout: 10000 });
    return untouched && await p.exited === 0;
  }
  try {
    const parsed = JSON.parse(answer.match(/\{[^{}]*\}/)?.[0] ?? "");
    const expected = task === "output" ? { code: "E_POLICY_MISSING", path: "src/component-17.ts" } : data.expected;
    return Object.entries(expected).every(([key, value]) => parsed[key] === value);
  } catch { return false; }
}
