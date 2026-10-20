import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createAgent, type AgentClient } from "./agent";
import { put } from "./inbox";
import type { Entry, NewEntry, Transcript } from "./transcript";
import type { Tool, ToolContext } from "./tools/index";

const home = mkdtempSync(join(tmpdir(), "parallels-agent-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const user = (text: string): NewEntry => ({ type: "message", message: { role: "user", content: text } });

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

// Content is loosely typed: the SDK's ToolUseBlock carries fields the loop never reads.
function reply(content: unknown[], stop: Message["stop_reason"]): Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Message["usage"],
  } as Message;
}

/** Returns each scripted message in order and records the params it was sent. */
function fakeClient(replies: Message[]) {
  const calls: { messages: MessageParam[]; tools?: unknown[] }[] = [];
  const client: AgentClient = {
    messages: {
      stream(params) {
        calls.push({ messages: params.messages, tools: params.tools });
        const msg = replies.shift();
        if (!msg) throw new Error("no more replies");
        return {
          on(_event, cb) {
            for (const b of msg.content) if (b.type === "text") cb(b.text);
          },
          async finalMessage() {
            return msg;
          },
        };
      },
    },
  };
  return { client, calls };
}

const ctx: ToolContext = { project: "p", role: "worker", cwd: "/" };

const echo: Tool = {
  spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } },
  async run(input) {
    return `echo:${input.text}`;
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
    const { client, calls } = fakeClient([reply([{ type: "text", text: "hello", citations: null }], "end_turn")]);
    let out = "";
    await createAgent({ client, transcript, tools: {}, model: "m", ctx, write: (t) => (out += t) }).run();

    expect(calls.length).toBe(1);
    expect(calls[0]!.tools).toBeUndefined();
    expect(out).toBe("hello\n");
    expect(transcript.entries.length).toBe(2);
    expect(transcript.entries[1]!.type).toBe("message");
    expect((transcript.entries[1] as { message: MessageParam }).message.role).toBe("assistant");
  });

  test("tool call round-trips its result", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const { client, calls } = fakeClient([
      reply([{ type: "tool_use", id: "tu1", name: "echo", input: { text: "x" } }], "tool_use"),
      reply([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    await createAgent({ client, transcript, tools: { echo }, model: "m", ctx, write: () => {} }).run();

    expect(calls.length).toBe(2);
    expect(calls[0]!.tools).toEqual([echo.spec]);
    const second = calls[1]!.messages;
    expect(second.length).toBe(3);
    expect(second[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "echo:x" }]);
    expect(transcript.entries.length).toBe(4);
  });

  test("tool error becomes is_error, not a crash", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    const { client, calls } = fakeClient([
      reply([{ type: "tool_use", id: "tu1", name: "boom", input: {} }], "tool_use"),
      reply([{ type: "text", text: "ok", citations: null }], "end_turn"),
    ]);
    await createAgent({ client, transcript, tools: { boom }, model: "m", ctx, write: () => {} }).run();

    const results = calls[1]!.messages[2]!.content;
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "kaboom", is_error: true }]);
  });

  test("messages waiting in the inbox are read before the first request and after each turn", async () => {
    const transcript = fakeTranscript();
    await transcript.append(user("go"));
    await put("p", "worker", { from: "orchestrator", text: "note before start" });
    let turns = 0;
    const { client, calls } = fakeClient([
      reply([{ type: "text", text: "first", citations: null }], "end_turn"),
      reply([{ type: "text", text: "second", citations: null }], "end_turn"),
    ]);
    const spyClient: AgentClient = {
      messages: {
        stream(params) {
          // A message lands while the agent is working on its first turn.
          const landed = turns++ === 0 ? put("p", "worker", { from: "orchestrator", text: "one more thing" }) : Promise.resolve();
          const stream = client.messages.stream(params);
          return { ...stream, finalMessage: () => landed.then(() => stream.finalMessage()) };
        },
      },
    };
    await createAgent({ client: spyClient, transcript, tools: {}, model: "m", ctx, write: () => {} }).run();

    expect(calls.length).toBe(2);
    expect(calls[0]!.messages.at(-1)!.content).toBe("[orchestrator] note before start");
    expect(calls[1]!.messages.at(-1)!.content).toBe("[orchestrator] one more thing");
  });
});
