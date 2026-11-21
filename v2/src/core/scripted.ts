// A provider that replays scripted replies from files, for end-to-end tests that cross processes (the daemon starts
// real worker processes). Selected only by ORCA2_SCRIPTED=<folder>: <folder>/<agent>.json holds a list of replies,
// each a list of content blocks; every request takes the first. Never used otherwise.
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { join } from "node:path";
import type { Provider } from "../api";
import { withStorageLock } from "./lock";

export function scriptedProvider(folder: string): Provider {
  return {
    name: "anthropic",
    account: "scripted:test",
    async complete(request) {
      const agent = request.trace?.agent ?? "unknown";
      const file = join(folder, `${agent}.json`);
      const reply = await withStorageLock(`${file}.lock`, async (): Promise<ContentBlock[]> => {
        const replies = await Bun.file(file).json().catch(() => []) as ContentBlock[][];
        const next = replies.shift();
        await Bun.write(file, JSON.stringify(replies));
        const exhausted: ContentBlock = { type: "text", text: `(script for ${agent} exhausted)`, citations: null };
        return next ?? [exhausted];
      });
      for (const block of reply) if (block.type === "text") request.onText(block.text);
      return { content: reply, completion: "end_turn", stop: reply.some(block => block.type === "tool_use") ? "tool_use" : "end", usage: { input: 10, output: 5 }, inputTokens: 10 };
    },
    async models() { return ["scripted"]; },
  };
}
