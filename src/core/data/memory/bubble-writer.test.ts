import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readProjectState } from "../../../config";
import { fakeProvider, text } from "../../../test/fake-provider";
import { memoryNodes, peekBubble, readNode } from "../bubbles";
import { open } from "../transcripts";
import { BubbleWriter, sliceText } from "./bubble-writer";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-bubble-writer-")); process.env.ORCA_HOME = home;
  await mkdir(join(paths.project("one"), "transcript"), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
const say = (t: ReturnType<typeof open>, role: "user" | "assistant", content: string) => t.append({ type: "message", message: { role, content } });
const long = "The user explained at length what they want from the sync change and why it matters for the agencies that rely on it. ".repeat(3);

test("a conversation's history is not imported on its first pass: memory starts from the next turn", async () => {
  const t = open(paths.transcript("one", "orchestrator"));
  await say(t, "user", `[user] ${long}`);
  const provider = fakeProvider([]);
  const writer = new BubbleWriter("one", t, false);
  writer.schedule({ model: "claude-opus-5-5", provider, signal: null });
  await writer.settled();
  expect(provider.calls.length).toBe(0);
  expect(readProjectState<string>("one", "bubble-distilled")).toBe(t.head()!);
});

test("a turn's decisions are written to memory, with the slice as their source, and are never read twice", async () => {
  const t = open(paths.transcript("one", "orchestrator"));
  const first = await say(t, "user", "[user] hello");
  const provider = fakeProvider([
    [text(JSON.stringify({ writes: [{ node: "decisions/flags", title: "Feature flags", summary: "No feature flags unless the user asks.", keywords: ["flag"], add: [{ text: "User decided: \"this is default behavior, no flags\"." }], retire: [], revision: null },
      { node: "nowhere", title: "x", summary: "y", keywords: null, add: [], retire: [], revision: null }] }))],
    [text("```json\n{\"writes\": []}\n```")],
  ]);
  const lines: string[] = [];
  const writer = new BubbleWriter("one", t, false, line => lines.push(line));
  const target = { model: "claude-opus-5-5", provider, signal: null };
  writer.schedule(target); await writer.settled();
  const asked = await say(t, "user", `[user] this is default behavior, no flags. ${long}`);
  const answered = await say(t, "assistant", "Understood: I have asked the workers to remove both flags.");
  writer.schedule(target); await writer.settled();
  expect(provider.calls.length).toBe(1);
  const sent = JSON.parse(provider.calls[0]!.messages[0]!.content as string);
  expect(sent.slice).toContain("IN: [user] this is default behavior, no flags.");
  expect(sent.slice).not.toContain("hello");
  const node = await readNode(peekBubble("one")!, "decisions/flags");
  expect(node!.entries).toEqual([{ text: "User decided: \"this is default behavior, no flags\".", at: node!.updated, author: "one", sources: [`one:${asked.uuid}..${answered.uuid}`], retired: null }]);
  expect(lines).toEqual([expect.stringContaining("wrote decisions/flags; refused nowhere: invalid memory node id")]);
  expect(readProjectState<string>("one", "bubble-distilled")).toBe(answered.uuid);
  writer.schedule(target); await writer.settled();
  expect(provider.calls.length).toBe(1);
  await say(t, "user", `[user] and what about rollout? ${long}`);
  writer.schedule(target); await writer.settled();
  expect(provider.calls.length).toBe(2);
  expect((await memoryNodes(peekBubble("one")!)).length).toBe(1);
  expect(first.uuid).not.toBe(asked.uuid);
});

test("a failed pass keeps its place and is read again later", async () => {
  const t = open(paths.transcript("one", "orchestrator"));
  const first = await say(t, "user", "[user] hi");
  const lines: string[] = [];
  const writer = new BubbleWriter("one", t, false, line => lines.push(line));
  const broken = fakeProvider([[text("not json")]]);
  writer.schedule({ model: "claude-opus-5-5", provider: broken, signal: null }); await writer.settled();
  await say(t, "user", `[user] decide this. ${long}`);
  writer.schedule({ model: "claude-opus-5-5", provider: broken, signal: null }); await writer.settled();
  expect(lines).toEqual([expect.stringContaining("pass failed, will retry later")]);
  expect(readProjectState<string>("one", "bubble-distilled")).toBe(first.uuid);
});

test("a slice of tool traffic alone is skipped without a model call", async () => {
  expect(sliceText([{ type: "message", uuid: "a", parentUuid: null, ts: "t", message: { role: "user", content: [{ type: "text", text: "[Orca reference context: brief]\nsomething" }] } }]))
    .toEqual({ text: "", said: false });
});
