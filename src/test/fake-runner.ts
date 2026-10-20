// A scripted stand-in for the SDK Tool Runner. Each iteration yields the next
// scripted assistant message; generateToolResponse runs the runnable tools the
// way the SDK does (errors become `Error: <message>` with is_error).

import type { BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import type { AgentClient, AgentRunner } from "../agent";

export type ContentBlock = BetaMessage["content"][number];

export const text = (t: string): ContentBlock => ({ type: "text", text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown): ContentBlock =>
  ({ type: "tool_use", id, name, input }) as ContentBlock;

export interface Call {
  messages: BetaMessageParam[];
  tools: string[];
}

/** `script` is one content array per assistant turn; stop_reason is inferred from tool_use blocks. */
export function fakeClient(script: ContentBlock[][]): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    beta: {
      messages: {
        toolRunner(params: BetaToolRunnerParams & { stream: true }): AgentRunner {
          const tools = params.tools as BetaRunnableTool[];
          const messages: BetaMessageParam[] = [...params.messages];
          let last: BetaMessage | null = null;
          let pending: Promise<BetaMessageParam | null> | null = null;

          async function runTools(message: BetaMessage): Promise<BetaMessageParam | null> {
            const results: BetaToolResultBlockParam[] = [];
            for (const block of message.content) {
              if (block.type !== "tool_use") continue;
              const tool = tools.find((t) => t.name === block.name);
              try {
                if (!tool) throw new Error(`unknown tool: ${block.name}`);
                results.push({ type: "tool_result", tool_use_id: block.id, content: await tool.run(tool.parse(block.input)) });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${msg}`, is_error: true });
              }
            }
            if (results.length === 0) return null;
            const response: BetaMessageParam = { role: "user", content: results };
            messages.push(response);
            return response;
          }

          const runner: AgentRunner = {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                const content = script.shift();
                if (!content) throw new Error("fake runner: script exhausted");
                calls.push({ messages: [...messages], tools: tools.map((t) => t.name) });
                const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
                last = { id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason: stop } as BetaMessage;
                messages.push({ role: "assistant", content });
                pending = null;
                const message = last;
                yield {
                  on(_event: "text", cb: (delta: string) => void) {
                    for (const b of content) if (b.type === "text") cb(b.text);
                  },
                  async finalMessage() {
                    return message;
                  },
                };
                if (stop !== "tool_use") return;
                await runner.generateToolResponse();
              }
            },
            generateToolResponse() {
              if (!last) return Promise.resolve(null);
              pending ??= runTools(last);
              return pending;
            },
          };
          return runner;
        },
      },
    },
  };
}
