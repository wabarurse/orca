import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { join } from "node:path";
import type { Provider } from "../api";
import { z } from "zod";
import { withStorageLock } from "./lock";
import { parseJson } from "./result";

const Block = z.looseObject({ type: z.string() });
const Replies = z.array(z.array(z.custom<ContentBlock>(value => Block.safeParse(value).success)));

export function scriptedProvider(folder: string): Provider {
  return {
    name: "anthropic",
    account: "scripted:test",
    async complete(request) {
      const agent = request.trace?.agent ?? "unknown";
      const file = join(folder, `${agent}.json`);
      const reply = await withStorageLock(`${file}.lock`, async (): Promise<ContentBlock[]> => {
        const json = parseJson(await Bun.file(file).text().catch(() => "[]"));
        const parsed = json.ok ? Replies.safeParse(json.data) : null;
        const replies = parsed !== null && parsed.success ? parsed.data : [];
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
