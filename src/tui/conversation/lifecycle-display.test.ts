import { expect, test } from "bun:test";
import { modelRequestText, type Entry, type ModelRequestEntry } from "../../protocol/transcript";
import { entryNotice } from "./notices";
import { restore } from "./restore";
import { parts, render } from "./view";
import { Calls, collapseCalls, groupStart } from "./tools";
import { historyRows, type Line } from "./lines";

const base = { uuid: "fixture", parentUuid: null, ts: "" };
const lifecycle = (stage: ModelRequestEntry["stage"]): ModelRequestEntry => ({
  ...base, type: "model-request", requestId: "request", provider: "openai", model: "gpt-6-astra", stage,
  startedAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:08Z",
});
const batch = (id: string): Entry[] => [
  { ...base, type: "message", message: { role: "assistant", content: [{ type: "tool_use", id, name: "bash", input: { command: `echo ${id}` } }] } },
  { ...base, type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
];
const progress = [lifecycle("preparing"), lifecycle("provider-wait"), lifecycle("completed"), lifecycle("error"), lifecycle("aborted")];
const text = (lines: Line[]) => Bun.stripANSI(historyRows(collapseCalls(lines), 120).join("\n"));

test("live status and transcript replay leave consecutive finished calls collapsed and expandable", () => {
  const entries = [...batch("one"), ...progress, ...batch("two")];
  const followed = new Calls();
  const live: Line[] = [];
  for (const entry of entries) {
    if (entry.type === "model-request") {
      // App's live notice routing: progress updates the transient note only.
      expect(entryNotice(entry)).toBe(modelRequestText(entry));
      expect(parts(entry)).toBeNull();
      expect(render(entry)).toBeNull();
    } else live.push(...followed.absorb(parts(entry) ?? []));
  }
  for (const lines of [live, restore(entries, 120, Infinity)]) {
    expect(text(lines)).toBe("▸ 2 tool calls · bash ×2");
    const start = groupStart(lines, collapseCalls(lines), 0);
    expect(start).toBe(0);
    const expanded = Bun.stripANSI(historyRows(collapseCalls(lines, new Set([start!])), 120).join("\n"));
    expect(expanded).toContain("▾ 2 tool calls");
    expect(expanded).toContain("bash(echo one)");
    expect(expanded).toContain("bash(echo two)");
  }
  followed.absorb(parts(batch("active")[0]!)!);
  expect(followed.size).toBe(1);
  expect(Bun.stripANSI(followed.rows(0, 120).join("\n"))).toContain("bash(echo active)");
  expect(text(live)).toBe("▸ 2 tool calls · bash ×2");
});

test("assistant text remains a group boundary in both history paths", () => {
  const assistant: Entry = { ...base, type: "message", message: { role: "assistant", content: "Let me explain." } };
  const entries = [...batch("one"), assistant, ...batch("two")];
  const calls = new Calls();
  for (const lines of [entries.flatMap(e => calls.absorb(parts(e) ?? [])), restore(entries, 120, Infinity)]) {
    expect(text(lines)).not.toContain("2 tool calls");
    expect(text(lines)).toContain("Let me explain.");
  }
});
