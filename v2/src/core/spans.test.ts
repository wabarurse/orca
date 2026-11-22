import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config";
import { tempHome } from "../test/home";
import { clock, flushSpans, phaseText, phaseTracker, readSpans, spanRecorder } from "./spans";
import type { AgentEvent } from "./types";

const home = tempHome("spans");

test("a span is emitted at start and end and appended once, never model-visible", async () => {
  const events: AgentEvent[] = [];
  const spans = spanRecorder("c-ok", "worker-a", event => { events.push(event); });
  const handle = spans.begin("tool", "bash: ls", Date.now() - 1500, "call-1");
  handle.end({ ok: "yes" });
  handle.end({ ok: "again" });
  expect(await spans.time("model", "m", async () => 7, value => ({ output: value }))).toBe(7);
  await expect(spans.time("prep", "request", async () => { throw new Error("boom"); }, () => ({}))).rejects.toThrow("boom");
  await flushSpans();
  expect(events.map(e => e.kind)).toEqual(["span_start", "span_end", "span_start", "span_end", "span_start", "span_end"]);
  const read = await readSpans("c-ok");
  expect(read.ok).toBe(true);
  const recorded = read.ok ? read.data : [];
  expect(recorded.map(s => `${s.kind}:${s.label}:${JSON.stringify(s.detail)}`)).toEqual(['tool:bash: ls:{"ok":"yes"}', 'model:m:{"output":7}', 'prep:request:{"error":"boom"}']);
  expect(recorded[0]?.id).toBe("call-1");
  expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(1500);
  expect(recorded[0]?.agent).toBe("worker-a");
});

test("a failed write never fails the caller and gives one notice", async () => {
  mkdirSync(paths.conversations, { recursive: true });
  writeFileSync(join(paths.conversations, "c-broken"), "not a folder");
  const notices: string[] = [];
  const spans = spanRecorder("c-broken", "orchestrator", event => { if (event.kind === "notice") notices.push(event.text); });
  spans.begin("model", "m", null, null).end({});
  spans.begin("model", "m", null, null).end({});
  await flushSpans();
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain("span recording unavailable");
  expect(home.path().length).toBeGreaterThan(0);
});

test("a phase tracker keeps one open span per phase and closes it when the phase changes", async () => {
  const events: AgentEvent[] = [];
  const idle = phaseTracker(spanRecorder("c-phase", "orchestrator", event => { events.push(event); }));
  const first = idle.observe("wait-worker", "worker-a");
  expect(idle.observe("wait-worker", "worker-a")).toBe(first);
  idle.observe("wait-inbox", "input");
  idle.close();
  idle.close();
  await flushSpans();
  expect(events.map(e => e.kind === "span_start" || e.kind === "span_end" ? `${e.kind} ${e.span.kind}` : e.kind))
    .toEqual(["span_start wait-worker", "span_end wait-worker", "span_start wait-inbox", "span_end wait-inbox"]);
  expect(idle.current()).toBe(null);
});

test("phase text reads like the activity line", () => {
  const startedAt = new Date(1_000_000).toISOString();
  expect(phaseText({ id: "a", kind: "wait-worker", label: "worker-fix-x", agent: "orchestrator", startedAt }, 1_000_000 + 72_400)).toBe("waiting for worker-fix-x (1m12s)");
  expect(phaseText({ id: "b", kind: "model", label: "claude-opus-5-5", agent: "orchestrator", startedAt }, 1_000_000 + 8_900)).toBe("thinking… (8s)");
  expect(clock(-5)).toBe("0s");
});
