import type { ImageBlockParam, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { blockRef } from "./images";

/** A tool-read image (nested in a tool_result) is not retained past a summary: its file can be read again. */
function marker(image: ImageBlockParam, read = false): TextBlockParam {
  const ref = blockRef(image), id = ref ? `; attachment_id=${ref.id}` : " (unscoped)";
  return { type: "text", text: read
    ? `[Historical image read by a tool${id}; not inspected by this text summary/search and not retained past it; read the file again to see it.]`
    : `[Historical image${id}; pixels retained separately, not inspected by this text summary/search.]` };
}

/** Text-only summaries/search are not vision calls. Keep IDs searchable, not
 * bytes or URLs; real scoped blocks survive separately in checkpoints and raw
 * archive records. Also sanitize legacy inline/nested images, never echo them.
 * Only inspect content blocks, never arbitrary tool input objects. */
export function historicalMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map(m => ({ ...m, content: typeof m.content === "string" ? m.content
    : m.content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking").map(b => {
      if (b.type === "image") return marker(b);
      if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map(c => c.type === "image" ? marker(c, true) : c) };
      return b;
    }) }));
}
