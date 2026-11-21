import { expect, test } from "bun:test";
import type { AgentEvent, OpenSpan } from "../core/types";
import { tail } from "./view";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();
const open = (id: string, kind: OpenSpan["kind"], label: string, secondsAgo: number): OpenSpan => ({ id, kind, label, agent: "orchestrator", startedAt: at(secondsAgo) });
const plain = (rows: string[]): string => Bun.stripANSI(rows.join("\n"));

test("the activity line names the current phase and its elapsed time", () => {
  const model: AgentEvent[] = [{ kind: "span_start", span: open("m", "model", "claude-opus-5-5", 8) }];
  expect(plain(tail(model, "", 80, NOW, true, null))).toContain("model claude-opus-5-5 (8s)");

  const call = { id: "t1", name: "bash", input: { command: "bun test src/core" } };
  const tool: AgentEvent[] = [{ kind: "tool_start", call }, { kind: "span_start", span: open("t1", "tool", "bash: bun test src/core", 34) }];
  const shown = plain(tail(tool, "", 80, NOW, true, null));
  expect(shown).toContain("bun test src/core) (34s)");
  expect(shown).not.toContain("thinking");

  const ended: AgentEvent[] = [...model, { kind: "span_end", span: { ...open("m", "model", "claude-opus-5-5", 8), endedAt: at(0), durationMs: 8000, detail: {} } }];
  expect(plain(tail(ended, "", 80, NOW, true, null))).toContain("thinking…");
});

test("between turns the orchestrator shows what it waits for, but not an idle wait for input", () => {
  expect(plain(tail([], "", 80, NOW, false, open("w", "wait-worker", "worker-fix-x", 72)))).toBe("waiting for worker-fix-x (1m12s)");
  expect(tail([], "", 80, NOW, false, open("i", "wait-inbox", "input", 72))).toEqual([]);
});
