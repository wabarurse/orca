import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
export function paired(messages: MessageParam[]): boolean {
  const seen = new Set<string>();
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") return false;
    const blocks = typeof message.content === "string" ? [] : message.content;
    if (pending.size > 0 && message.role !== "user") return false;
    const next = validateBlocks(message.role, blocks, seen, pending);
    if (next === null) return false;
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
  if (pending.size > 0) return null;
  return uses;
}

function validUse(role: string, id: string, seen: Set<string>, pending: Set<string>): boolean {
  return role === "assistant" && typeof id === "string" && id.length > 0 && !seen.has(id) && pending.size === 0;
}

type Block = Exclude<MessageParam["content"], string>[number];

const blocksOf = (message: MessageParam): Block[] => typeof message.content === "string"
  ? (message.content.length > 0 ? [{ type: "text", text: message.content }] : []) : message.content;

export function pairResults(messages: MessageParam[]): MessageParam[] {
  if (paired(messages)) return messages;
  const out: MessageParam[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    i++;
    if (message === undefined) continue;
    out.push(message);
    const uses = new Set(blocksOf(message).flatMap(block => message.role === "assistant" && block.type === "tool_use" ? [block.id] : []));
    if (uses.size === 0) continue;
    const start = i;
    const results: Block[] = [];
    const after: MessageParam[] = [];
    let displaced = false;
    while (i < messages.length && messages[i]?.role === "user") {
      const next = messages[i];
      i++;
      if (next === undefined) continue;
      const blocks = blocksOf(next);
      const mine = blocks.filter(block => block.type === "tool_result" && uses.has(block.tool_use_id));
      if (mine.length > 0 && (after.length > 0 || results.length > 0)) displaced = true;
      results.push(...mine);
      if (mine.length === 0) { after.push(next); continue; }
      const rest = blocks.filter(block => !mine.includes(block));
      if (rest.length > 0) after.push({ role: "user", content: rest });
    }
    if (!displaced) { out.push(...messages.slice(start, i)); continue; }
    out.push({ role: "user", content: results }, ...after);
  }
  return out;
}
