import { describe, expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createAgent, runnable } from "./agent";
import { fakeClient, text, toolUse } from "./test/fake-runner";
import type { Entry, NewEntry, Transcript } from "./transcript";
import type { Tool, ToolContext } from "./tools/index";

const user = (t: string): NewEntry => ({ type: "message", message: { role: "user", content: t } });

function fakeTranscript(): Transcript & { entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    path: "/dev/null",
    entries,
    async append(e) {
      const entry = { ...e, uuid: String(entries.length), ts: "t" } as Entry;
      entries.push(entry);
      return entry;
    },
    async chain() {
      return entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
    },
    head() {
      return entries.at(-1)?.uuid ?? null;
    },
  };
}

const ctx: ToolContext = { project: "p", role: "worker", cwd: "/" };

const echo: Tool = {
  spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } },
  async run(input, c) {
    return `echo:${input.text}:${c.role}`;
  },
};

const boom: Tool = {
  spec: { name: "boom", description: "fails", input_schema: { type: "object", properties: {} } },
  async run() {
    throw new Error("kaboom");
  },
};

describe("agent loop", () => {
  test("text-only turn ends the loop and is streamed", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("hi"));
    const client = fakeClient([[text("hello")]]);
    let out = "";
    await createAgent({ client, transcript, tools: {}, model: "m", ctx, write: (t) => (out += t) }).run();

    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.tools).toEqual([]);
    expect(out).toBe("hello\n");
    expect(transcript.entries.length).toBe(2);
    expect((transcript.entries[1] as { message: MessageParam }).message.role).toBe("assistant");
  });

  test("tool call round-trips its result with the agent's context", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const client = fakeClient([[toolUse("tu1", "echo", { text: "x" })], [text("done")]]);
    let out = "";
    await createAgent({ client, transcript, tools: { echo }, model: "m", ctx, write: (t) => (out += t) }).run();

    expect(client.calls.length).toBe(2);
    expect(client.calls[0]!.tools).toEqual(["echo"]);
    const second = client.calls[1]!.messages;
    expect(second.length).toBe(3);
    expect(second[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "echo:x:worker" }]);
    expect(out).toContain("▸ echo");
    // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(transcript.entries.map((e) => (e as { message: MessageParam }).message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("tool error becomes is_error, not a crash", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const client = fakeClient([[toolUse("tu1", "boom", {})], [text("ok")]]);
    await createAgent({ client, transcript, tools: { boom }, model: "m", ctx, write: () => {} }).run();

    const results = client.calls[1]!.messages[2]!.content;
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "Error: kaboom", is_error: true }]);
  });

  test("runnable wraps our tools as SDK runnable tools", async () => {
    const [tool] = runnable({ echo }, ctx);
    expect(tool!.name).toBe("echo");
    expect(await tool!.run(tool!.parse({ text: "y" }))).toBe("echo:y:worker");
  });
});
