// A scripted provider: each complete() returns the next content array and
// records what it was asked. stop is inferred from tool_use blocks.

import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { CompleteRequest, Provider } from "../providers/provider";

export const text = (t: string): ContentBlock => ({ type: "text", text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown): ContentBlock =>
  ({ type: "tool_use", id, name, input }) as ContentBlock;

export interface Call {
  messages: MessageParam[];
  tools: string[];
}

export function fakeProvider(script: ContentBlock[][]): Provider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: "anthropic",
    calls,
    async complete(req: CompleteRequest) {
      calls.push({ messages: req.messages, tools: req.tools.map((t) => t.name) });
      const content = script.shift();
      if (!content) throw new Error("fake provider: script exhausted");
      for (const b of content) if (b.type === "text") req.onText(b.text);
      return { completion: "end_turn", content, stop: content.some((b) => b.type === "tool_use") ? ("tool_use" as const) : ("end" as const) };
    },
    async models() {
      return ["fake-model"];
    },
  };
}
