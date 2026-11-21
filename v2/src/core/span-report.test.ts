import { expect, test } from "bun:test";
import { formatReport, spanReport } from "./span-report";
import type { Span, SpanKind } from "./types";

const T = Date.parse("2026-01-01T00:00:00.000Z");
let n = 0;
const span = (agent: string, kind: SpanKind, label: string, from: number, to: number): Span =>
  ({ id: `s${n++}`, kind, label, agent, startedAt: new Date(T + from * 1000).toISOString(), endedAt: new Date(T + to * 1000).toISOString(), durationMs: (to - from) * 1000, detail: {} });

const FIXTURE: Span[] = [
  span("orchestrator", "prep", "session", 0, 0.5),
  span("orchestrator", "prep", "request", 0.5, 1),
  span("orchestrator", "model", "claude-opus-5-5", 1, 5),
  span("orchestrator", "tool", "subagent: fix, worker", 5, 6),
  span("orchestrator", "prep", "request", 6, 6.2),
  span("orchestrator", "model", "claude-opus-5-5", 6.2, 8),
  span("orchestrator", "wait-worker", "worker-fix", 8, 68),
  span("orchestrator", "prep", "request", 70, 70.5),
  span("orchestrator", "model", "claude-opus-5-5", 70.5, 75),
  span("orchestrator", "wait-inbox", "input", 75, 135),
  span("worker-fix", "spawn", "worker-fix", 5.5, 7.5),
  span("worker-fix", "prep", "session", 7.5, 8),
  span("worker-fix", "model", "claude-sonnet-5-5", 8, 20),
  span("worker-fix", "tool", "bash: bun test src/core", 20, 50),
  span("worker-fix", "wait-inbox", "user confirmation", 20, 25),
  span("worker-fix", "model", "claude-sonnet-5-5", 50, 60),
  span("worker-fix", "tool", "inbox: orchestrator: done", 60, 60.2),
];

const total = (kinds: Record<string, number>): number => Object.values(kinds).reduce((a, b) => a + b, 0);

test("the breakdown attributes every moment once: innermost span per agent, the busiest kind across agents, gaps as unaccounted", () => {
  const report = spanReport("c1", FIXTURE);
  expect(report.wallMs).toBe(135_000);
  expect(report.kinds).toEqual({ "model": 32_300, "tool": 26_200, "spawn": 200, "prep": 1_500, "compaction": 0, "wait-process": 0, "wait-worker": 12_800, "wait-inbox": 60_000, "unaccounted": 2_000 });
  expect(total(report.kinds)).toBe(report.wallMs);
  expect(report.activeMs).toBe(75_000);
  expect(report.nonModelMs).toBe(42_700);
  const worker = report.agents.find(agent => agent.agent === "worker-fix");
  expect(worker?.kinds).toMatchObject({ "tool": 25_200, "wait-inbox": 5_000, "model": 22_000, "spawn": 2_000, "prep": 500 });
  for (const agent of report.agents) expect(total(agent.kinds)).toBe(agent.wallMs);
  expect(report.agents.find(agent => agent.agent === "orchestrator")?.kinds.unaccounted).toBe(2_000);
  expect(report.longest.map(s => s.label).slice(0, 3)).toEqual(["worker-fix", "input", "bash: bun test src/core"]);
});

test("the printed breakdown leads with where the non-model time went", () => {
  expect(formatReport(spanReport("c1", FIXTURE))).toBe(EXPECTED);
  expect(formatReport(spanReport("c2", []))).toBe("conversation c2: no spans recorded\n");
});

const EXPECTED = `conversation c1 · wall 2m15s · active 1m15s · idle for input 1m00s
model 32s (43% of active) · non-model 43s (57%)

where the non-model time went:
  tool              26s   35%
  wait-worker       13s   17%
  unaccounted      2.0s    3%
  prep             1.5s    2%
  spawn           200ms    0%

by agent (each agent's own time; waits overlap other agents' work):
  orchestrator         wall   2m15s · 10 spans · model 10s · tool 1.0s · prep 1.7s · wait-worker 1m00s · wait-inbox 1m00s · unaccounted 2.0s
  worker-fix           wall     55s · 7 spans · model 22s · tool 25s · spawn 2.0s · prep 500ms · wait-inbox 5.0s

longest spans:
   1.   1m00s  wait-worker  orchestrator         worker-fix
   2.   1m00s  wait-inbox   orchestrator         input
   3.     30s  tool         worker-fix           bash: bun test src/core
   4.     12s  model        worker-fix           claude-sonnet-5-5
   5.     10s  model        worker-fix           claude-sonnet-5-5
   6.    5.0s  wait-inbox   worker-fix           user confirmation
   7.    4.5s  model        orchestrator         claude-opus-5-5
   8.    4.0s  model        orchestrator         claude-opus-5-5
   9.    2.0s  spawn        worker-fix           worker-fix
  10.    1.8s  model        orchestrator         claude-opus-5-5
`;
