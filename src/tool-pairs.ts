import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
/** Supported grammar: assistant tool batch immediately followed by user results.
 * Text may accompany results (inbox notes); IDs are unique throughout this context. */
export function paired(messages: MessageParam[]): boolean {
  const seen = new Set<string>();
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") return false;
    const blocks = typeof message.content === "string" ? [] : message.content;
    if (pending.size && message.role !== "user") return false;
    const next = validateBlocks(message.role, blocks, seen, pending);
    if (!next) return false;
    pending = next;
  }
  return pending.size === 0;
}
function validateBlocks(role: string, blocks: Exclude<MessageParam["content"], string>, seen: Set<string>, pending: Set<string>): Set<string> | null {
  const uses = new Set<string>();
  for (const block of blocks) {
    if (block.type === "tool_use") {
      if (!validUse(role, block.id, seen, pending)) return null;
      seen.add(block.id); uses.add(block.id);
    }
    if (block.type === "tool_result" && (role !== "user" || !pending.delete(block.tool_use_id))) return null;
  }
  if (pending.size) return null;
  return uses;
}

function validUse(role: string, id: string, seen: Set<string>, pending: Set<string>): boolean {
  return role === "assistant" && typeof id === "string" && id.length > 0 && !seen.has(id) && pending.size === 0;
}
