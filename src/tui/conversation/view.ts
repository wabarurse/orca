// Render a transcript for a terminal and follow it as it grows. This is what
// picking an agent in /agents shows: the same view the orchestrator page gives you, for any agent.

import { existsSync, statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import type { Entry } from "../../protocol/transcript";
import { callText, resultText as summaryText, type ToolCall, type ToolOutcome } from "../../protocol/toolview";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const firstLine = (s: string, max = 100) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
};

/**
 * A piece of an entry as shown: plain styled text, an assistant's markdown
 * (`md`) for a renderer that lays it out, or a tool call starting (`call`) or
 * ending (`result`), for a renderer that pairs them (the TUI's tools.ts).
 */
export type Part = string | { md: string } | { call: ToolCall } | { result: ToolOutcome };

type Block = Exclude<Extract<Entry, { type: "message" }>["message"]["content"], string>[number];

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : ((content ?? []) as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text : "")).join("");

/** A content block as shown, or null for blocks with nothing to show (thinking). */
function blockPart(block: Block, text: (t: string) => Part): Part | null {
  if (block.type === "text") return text(block.text);
  if (block.type === "tool_use") return { call: { id: block.id, name: block.name, input: block.input } };
  if (block.type === "tool_result") return { result: { id: block.tool_use_id, ok: !block.is_error, text: resultText(block.content) } };
  return null;
}

/** Assistant text blocks in one model response are one logical message, as the streaming path concatenates them. */
function joinedText(blocks: Block[]): Block[] {
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return [...(text ? [{ type: "text" as const, text }] : []), ...blocks.filter((b) => b.type !== "text")];
}

/** One entry as pieces to show, or null for entries with nothing to show. */
export function parts(entry: Entry): Part[] | null {
  if (entry.type === "context-boundary") return null;
  if (entry.type === "meta") return [dim(`— ${entry.role}${entry.branch ? ` on ${entry.branch}` : ""} (${entry.model || "default model"})`)];
  if (entry.type === "summary") return [dim(`— compacted: ${firstLine(entry.text)}`)];
  if (entry.type === "replies") return entry.messages.flatMap((m): Part[] => [dim(`${m.from} → user:`), { md: m.text }]);
  const { role, content } = entry.message;
  const text = (t: string): Part => (role === "user" ? `${bold(">")} ${t}` : { md: t });
  if (typeof content === "string") return [text(content)];
  const blocks = role === "assistant" ? joinedText(content) : content;
  const out = blocks.map((b) => blockPart(b, text)).filter((p): p is Part => p !== null);
  return out.length ? out : null;
}

/** A part as plain terminal text: markdown as written, a call as its "⏺" line, a result as its first line. */
function partText(p: Part, calls: Map<string, ToolCall>): string {
  if (typeof p === "string") return p;
  if ("md" in p) return p.md;
  if ("call" in p) { calls.set(p.call.id, p.call); return callText(p.call); }
  const call = calls.get(p.result.id);
  calls.delete(p.result.id);
  return summaryText(call?.name ?? "tool", p.result);
}

/** One entry as terminal lines (markdown left as written), or null for entries with nothing to show. */
export function render(entry: Entry, calls = new Map<string, ToolCall>()): string | null {
  const ps = parts(entry);
  return ps && ps.map((p) => partText(p, calls)).join("\n");
}

/** Show one transcript line, skipping blank, partial or foreign ones. */
function emit(line: string, out: (s: string, entry: Entry) => void, calls: Map<string, ToolCall>): void {
  if (!line.trim()) return;
  let entry: Entry;
  try { entry = JSON.parse(line) as Entry; } catch { return; }
  const rendered = render(entry, calls);
  if (rendered) out(rendered, entry);
}

/**
 * Print everything in the transcript, then keep printing new entries until
 * `stop` resolves; `out` gets each entry's text and the entry itself. Reads
 * by byte offset so a partial trailing line waits for its newline.
 */
export async function follow(path: string, out: (s: string, entry: Entry) => void, stop: Promise<void>, intervalMs = 300, afterDrain: () => void = () => {}): Promise<void> {
  const calls = new Map<string, ToolCall>();
  let offset = 0;
  let done = false;
  stop.then(() => (done = true));

  async function drain(): Promise<void> {
    if (!existsSync(path) || statSync(path).size <= offset) return;
    const fh = await openFile(path, "r");
    try {
      const { size } = await fh.stat();
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      const text = buf.toString();
      const end = text.lastIndexOf("\n");
      if (end === -1) return;
      offset += Buffer.byteLength(text.slice(0, end + 1));
      for (const line of text.slice(0, end).split("\n")) emit(line, out, calls);
    } finally {
      await fh.close();
    }
  }

  while (!done) {
    await drain();
    afterDrain();
    await Bun.sleep(intervalMs);
  }
  await drain();
  afterDrain();
}
