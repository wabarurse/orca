import { expect, test } from "bun:test";
import type { AgentEvent, OpenSpan } from "../core/types";
import { CORE_FOLDS, items, tail, USER_ROWS, userItem, type Piece } from "./view";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();
const open = (id: string, kind: OpenSpan["kind"], label: string, secondsAgo: number): OpenSpan => ({ id, kind, label, agent: "orchestrator", startedAt: at(secondsAgo) });
const plain = (rows: string[]): string => Bun.stripANSI(rows.join("\n"));

test("the activity line names the current phase and its elapsed time", () => {
  const model: AgentEvent[] = [{ kind: "span_start", span: open("m", "model", "claude-opus-5-5", 8) }];
  expect(plain(tail(model, "", 80, NOW, true, null))).toContain("thinking… (8s)");

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

test("tool calls, agent messages and spawned agents fold the way the sketch shows", () => {
  const call = (id: string, name: string, input: Record<string, unknown>, text: string): Piece => ({ kind: "call", call: { call: { id, name, input }, outcome: { id, ok: true, text } } });
  const list: Piece[] = [
    call("a", "bash", { command: "ls" }, "x"), call("b", "read", { path: "a.ts" }, "y"),
    { kind: "text", text: "between" },
    call("c", "subagent", { action: "spawn", branch: "fix-a" }, "worker-fix-a started (bundle worker, log l)"),
    call("d", "subagent", { action: "spawn", branch: "fix-b" }, "worker-fix-b got the brief as a message (bundle worker, log l)"),
    { kind: "from", from: "worker-fix-a", text: "done" },
  ];
  const out = items(list, { cols: 80, open: new Set<string>(), folds: new Map(CORE_FOLDS) });
  const titles = out.flatMap(item => item.kind === "fold" ? [Bun.stripANSI(item.title)] : []);
  expect(titles).toEqual(["⚒ 2 tool calls · bash ×1, read ×1", "⚒ 2 tool calls · subagent ×2", "+ 2 agents", "✉ from agent worker-fix-a"]);
  const agents = out.find(item => item.kind === "fold" && item.title === "+ 2 agents");
  expect(agents?.kind === "fold" ? [agents.opens, agents.rows.map(r => Bun.stripANSI(r))] : null).toEqual(["agents", ["● worker-fix-a  open", "● worker-fix-b  open"]]);
});

test("one step's calls collapse together, whatever the tools, and a single call folds too", () => {
  const call = (id: string, name: string, input: Record<string, unknown>, text: string): Piece => ({ kind: "call", call: { call: { id, name, input }, outcome: { id, ok: true, text } } });
  const titles = (list: Piece[]): string[] => items(list, { cols: 80, open: new Set<string>(), folds: new Map(CORE_FOLDS) }).flatMap(item => item.kind === "fold" ? [Bun.stripANSI(item.title)] : []);
  expect(titles([call("a", "bash", { command: "ls" }, "x"), call("b", "subagent", { action: "spawn", branch: "fix" }, "worker-fix started (bundle worker, log l)")]))
    .toEqual(["⚒ 2 tool calls · bash ×1, subagent ×1", "+ 1 agent"]);
  expect(titles([call("a", "memory", { action: "write" }, "wrote")])).toEqual(["⚒ 1 tool call · memory ×1"]);
});

test("a long user message shows its first lines and how many more, all of them once opened", () => {
  const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
  const shut = userItem(text, "p-0", { cols: 80, open: new Set() });
  expect(shut.kind === "user" ? [shut.rows.length, shut.more, shut.open] : null).toEqual([USER_ROWS, 15, false]);
  const opened = userItem(text, "p-0", { cols: 80, open: new Set(["p-0"]) });
  expect(opened.kind === "user" ? [opened.rows.length, opened.more, opened.open] : null).toEqual([25, 15, true]);
  const short = userItem("hello", "p-1", { cols: 80, open: new Set(["p-1"]) });
  expect(short.kind === "user" ? [short.rows, short.more, short.open] : null).toEqual([["hello"], 0, false]);
});
