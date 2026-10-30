// Synthetic, isolated idle CPU probe; never runs model or GitHub requests.
// Usage: bun scripts/benchmark-idle.ts [source-checkout]
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = process.argv[2] ?? new URL("..", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "orca-idle-benchmark-"));
process.env.ORCA_HOME = root;
process.env.PARALLELS_HOME = join(root, "legacy");
const { paths, saveConfig, updateState } = await import(join(source, "src/config/index.ts"));
const { createOrchestrator } = await import(join(source, "src/core/agent-loop/orc/orchestrator.ts"));
const { runDaemon } = await import(join(source, "src/core/agent-loop/orc/daemon.ts"));
const { request } = await import(join(source, "src/core/agent-loop/orc/channel.ts"));
const p = "benchmark";
mkdirSync(paths.repo(p), { recursive: true });
await saveConfig({ model: "test", compact: false });
updateState(paths.memory, "benchmark", "present", () => true);
mkdirSync(join(paths.project(p), "transcript"), { recursive: true });
let parent: string | null = null;
const rows = [];
for (let i = 0; i < 5000; i++) {
  const uuid = crypto.randomUUID();
  rows.push(JSON.stringify({ uuid, parentUuid: parent, type: "message", ts: new Date().toISOString(), message: { role: i % 2 ? "assistant" : "user", content: "synthetic fixture ".repeat(70) } }));
  parent = uuid;
}
const transcript = rows.join("\n") + "\n";
writeFileSync(paths.transcript(p, "orchestrator"), transcript);
for (let i = 0; i < 250; i++) {
  const id = crypto.randomUUID(), dir = join(paths.runtimeProject(p), "processes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id, project: p, state: "exited", notify: true, events: [], createdAt: "2026-01-01T00:00:00Z" }));
}
const provider = { name: "anthropic", models: async () => [], complete: async () => { throw Error("benchmark must not call model"); } };
const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
let polls = 0;
const pending = session.pending;
session.pending = () => { polls++; return pending(); };
const running = runDaemon({ project: p, run: "benchmark", session, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
await Bun.sleep(1500);
polls = 0;
const before = process.cpuUsage(), at = performance.now();
await Bun.sleep(5000);
const elapsed = performance.now() - at, cpu = process.cpuUsage(before);
const result = { source, transcriptBytes: Buffer.byteLength(transcript), completedProcesses: 250, elapsedMs: Math.round(elapsed), cpuMs: Math.round((cpu.user + cpu.system) / 1000), cpuPercent: Math.round((cpu.user + cpu.system) / elapsed * 10) / 100, idleChecks: polls };
await request(p, { kind: "stop" });
await running;
session.dispose?.();
console.log(JSON.stringify(result));
rmSync(root, { recursive: true, force: true });
