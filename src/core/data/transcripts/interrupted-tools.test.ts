import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { completeInterruptedTools, interruptedMessages, open } from "./transcript";
import { paired } from "../transcripts/tool-pairs";
import { toResponses } from "../../../providers/openai";
import { parts } from "../../../tui/conversation/view";
import { createAgent } from "../../agent-loop/loop/agent";
import { fakeProvider, text } from "../../../test/fake-provider";

const home = mkdtempSync(join(tmpdir(), "interrupted-tools-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const use = (id: string) => ({ type: "tool_use" as const, id, name: "bash", input: { command: "git push" } });
const result = (id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: "existing outcome" });
const batch = (...ids: string[]): MessageParam => ({ role: "assistant", content: ids.map(use) });
const user = (content: MessageParam["content"]): MessageParam => ({ role: "user", content });
async function fixture(messages: MessageParam[]) {
  const t = open(join(home, crypto.randomUUID() + ".jsonl"));
  for (const message of messages) await t.append({ type: "message", message });
  return t;
}

test("aborted push gets a durable unknown error before the next request, never executes", async () => {
  const persisted = await fixture([user("publish"), batch("push"), user("resume"), user("STOP")]);
  const t = open(persisted.path);
  const before = readFileSync(t.path, "utf8");
  const provider = fakeProvider([[text("reconcile first")]]);
  let executions = 0;
  await createAgent({ transcript: t, provider, model: "m", ctx: { project: "p", role: "reviewer", cwd: home },
    tools: { bash: { spec: { name: "bash", description: "never execute", input_schema: { type: "object" } },
      async run() { executions++; throw new Error("must not run"); } } }, write: () => {},
  }).run();
  expect(executions).toBe(0);
  const messages = provider.calls[0]!.messages;
  expect(paired(messages)).toBe(true);
  expect(messages[2]).toEqual(user([{ type: "tool_result", tool_use_id: "push", is_error: true,
    content: "interrupted; outcome unknown—reconcile before retrying" }]));
  expect(messages.slice(3)).toEqual([user("resume"), user("STOP")]);
  expect(readFileSync(t.path, "utf8").startsWith(before)).toBe(true);
  expect(open(t.path).history!().filter(e => e.type === "message").slice(0, 4).map(e => e.type === "message" && e.message))
    .toEqual([user("publish"), batch("push"), user("resume"), user("STOP")]);
  expect(t.all!().filter(e => e.type === "tool-recovery")).toHaveLength(1);
  const reopened = open(t.path);
  const bytes = readFileSync(t.path, "utf8");
  await completeInterruptedTools(reopened);
  await reopened.refresh!();
  await completeInterruptedTools(reopened);
  expect(readFileSync(t.path, "utf8")).toBe(bytes);
});

test("partial multi-call keeps existing results and legitimate user interposition; adapters preserve IDs/errors", async () => {
  const existing = result("a");
  const messages = [user("start"), batch("a", "b", "c"), user("new instruction"),
    user([existing, { type: "text" as const, text: "inbox note" }])];
  const recovered = interruptedMessages(messages)!;
  expect(paired(recovered)).toBe(true);
  expect((recovered[2]!.content as unknown[])[0]).toBe(existing);
  expect(recovered.slice(3)).toEqual([user("new instruction"), user([{ type: "text", text: "inbox note" }])]);
  const outputs = toResponses(recovered).filter(x => x.type === "function_call_output");
  expect(outputs.map(x => x.call_id)).toEqual(["a", "b", "c"]);
  expect(outputs[0]!.output).toBe("existing outcome");
  expect(outputs[1]!.output).toBe("Error: interrupted; outcome unknown—reconcile before retrying");
  expect(interruptedMessages(recovered)).toBeNull();
});

test("matched batches, including inbox text, are byte-for-byte untouched", async () => {
  const t = await fixture([batch("a"), user([result("a"), { type: "text", text: "keep" }])]);
  const before = readFileSync(t.path, "utf8");
  await completeInterruptedTools(t);
  expect(readFileSync(t.path, "utf8")).toBe(before);
});

test("orphan, duplicate, reused and non-final unresolved calls fail closed", () => {
  for (const messages of [
    [user([result("orphan")])],
    [batch("a", "a")],
    [batch("a", "b"), user([result("a"), result("a")])],
    [batch("a"), user([result("a")]), batch("a")],
    [batch("a"), { role: "assistant" as const, content: "skipped result" }],
    [batch("a"), user([result("other")])],
    [batch("a"), user("interposed"), user([result("a")])],
  ]) expect(() => interruptedMessages(messages)).toThrow("invalid tool history");
});

test("cancelled authorization never publishes; competing writers fail closed then reread idempotently", async () => {
  const t = await fixture([batch("push")]);
  const before = readFileSync(t.path, "utf8");
  await expect(completeInterruptedTools(t, AbortSignal.abort())).rejects.toThrow();
  expect(readFileSync(t.path, "utf8")).toBe(before);
  const other = open(t.path);
  const outcomes = await Promise.allSettled([completeInterruptedTools(t), completeInterruptedTools(other)]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(o => o.status === "rejected")).toHaveLength(1);
  await other.refresh!();
  await completeInterruptedTools(other);
  expect(other.all!().filter(e => e.type === "tool-recovery")).toHaveLength(1);
  expect(paired(await other.chain())).toBe(true);
});

test("fresh-inbox requirement and aborted runs do not authorize recovery or requests", async () => {
  const t = await fixture([batch("push")]);
  const provider = fakeProvider([[text("not requested")]]);
  const deps = { transcript: t, provider, model: "m", tools: {},
    ctx: { project: "empty", role: "orchestrator" as const, cwd: home }, write: () => {} };
  await createAgent({ ...deps, requireInbox: true }).run();
  await expect(createAgent({ ...deps, signal: AbortSignal.abort() }).run()).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
  expect(t.all!().filter(e => e.type === "tool-recovery")).toHaveLength(0);
});


test("recovery checkpoint renders an honest diagnostic without duplicating history", () => {
  const rendered = parts({ type: "tool-recovery", uuid: "r", parentUuid: null, ts: "now", messages: [batch("push")] });
  expect(rendered).toHaveLength(1);
  expect(String(rendered![0])).toContain("outcome unknown—reconcile before retrying");
});


test("legacy retained checkpoint with persisted unfinished batch is recovered after reopen", async () => {
  const t = await fixture([user("original history")]);
  const retained = [user("retained instruction"), batch("legacy-push"), user("STOP")];
  await t.append({ type: "summary", text: "prior summary", retained });
  const bytes = readFileSync(t.path, "utf8");
  await completeInterruptedTools(open(t.path));
  const reopened = open(t.path);
  const messages = await reopened.chain();
  expect(paired(messages)).toBe(true);
  expect(messages.slice(0, 3)).toEqual([user("prior summary"), ...retained.slice(0, 2)]);
  expect(messages[3]).toEqual(user([{ type: "tool_result", tool_use_id: "legacy-push", is_error: true,
    content: "interrupted; outcome unknown—reconcile before retrying" }]));
  expect(messages[4]).toEqual(user("STOP"));
  expect(readFileSync(t.path, "utf8").startsWith(bytes)).toBe(true);
  expect(reopened.all!()).toHaveLength(3);
});
