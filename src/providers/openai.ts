import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ContentBlock, MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, Turn } from "./index";

/** Anthropic-shaped transcript → chat-completions messages. Thinking blocks are dropped. */
export function toChat(messages: MessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "user") {
      const text: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") text.push(b.text);
        else if (b.type === "tool_result") {
          const content =
            typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content });
        }
      }
      if (text.length) out.push({ role: "user", content: text.join("\n") });
    } else {
      const text: string[] = [];
      const tool_calls: ChatCompletionMessageToolCall[] = [];
      for (const b of m.content) {
        if (b.type === "text") text.push(b.text);
        else if (b.type === "tool_use") {
          tool_calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
        }
      }
      out.push({ role: "assistant", content: text.join("\n") || null, ...(tool_calls.length ? { tool_calls } : {}) });
    }
  }
  return out;
}

export function toChatTools(tools: ApiTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
  }));
}

// Credentials: OPENAI_API_KEY, or the key saved by /login openai.
export function openai(client: OpenAI): Provider {
  return {
    name: "openai",
    async complete(req): Promise<Turn> {
      const stream = await client.chat.completions.create({
        model: req.model,
        messages: toChat(req.messages),
        ...(req.tools.length ? { tools: toChatTools(req.tools) } : {}),
        stream: true,
      });
      let text = "";
      const calls: { id: string; name: string; args: string }[] = [];
      let finish: string | null = null;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          text += choice.delta.content;
          req.onText(choice.delta.content);
        }
        for (const tc of choice.delta.tool_calls ?? []) {
          const call = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const content: ContentBlock[] = [];
      if (text) content.push({ type: "text", text, citations: null });
      for (const c of calls) {
        let input: unknown = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          input = { _raw: c.args };
        }
        content.push({ type: "tool_use", id: c.id, name: c.name, input } as ContentBlock);
      }
      return { content, stop: calls.length && finish !== "stop" ? "tool_use" : calls.length ? "tool_use" : "end" };
    },
    async models() {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      // Chat models only; the list also has embeddings, audio, images, etc.
      return ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|search|moderation)/.test(id)).sort();
    },
  };
}
