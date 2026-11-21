import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { CompleteRequest, Provider, Turn } from "../api/provider";

export const text = (t: string): ContentBlock => ({ type: "text", text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown): ContentBlock =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } });

export type Call = {
  messages: MessageParam[];
  tools: string[];
};

export function fakeProvider(script: ContentBlock[][]): Provider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: "anthropic",
    calls,
    async complete(req: CompleteRequest): Promise<Turn> {
      calls.push({ messages: req.messages, tools: req.tools.map((t) => t.name) });
      const content = script.shift();
      if (content === undefined) throw new Error("fake provider: script exhausted");
      for (const b of content) if (b.type === "text") req.onText(b.text);
      return { completion: "end_turn", content, stop: content.some((b) => b.type === "tool_use") ? "tool_use" : "end" };
    },
    async models() {
      return ["fake-model"];
    },
  };
}
