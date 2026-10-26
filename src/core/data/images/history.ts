import type { ImageBlockParam, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { blockRef } from "./images";

function marker(image: ImageBlockParam): TextBlockParam {
  const ref = blockRef(image);
  return { type: "text", text: `[Historical image${ref ? `; attachment_id=${ref.id}` : " (unscoped)"}; pixels retained separately, not inspected by this text summary/search.]` };
}

/** Text-only summaries/search are not vision calls. Keep IDs searchable, not
 * bytes or URLs; real scoped blocks survive separately in checkpoints and raw
 * archive records. Also sanitize legacy inline/nested images, never echo them.
 * Only inspect content blocks, never arbitrary tool input objects. */
export function historicalMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map(m => ({ ...m, content: typeof m.content === "string" ? m.content
    : m.content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking").map(b => {
      if (b.type === "image") return marker(b);
      if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map(c => c.type === "image" ? marker(c) : c) };
      return b;
    }) }));
}
