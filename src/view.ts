// Render a transcript for a terminal and follow it as it grows. This is what
// picking an agent in /agents shows: the same view the orchestrator page gives you, for any agent.

import { existsSync, statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import type { Entry } from "./transcript";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const firstLine = (s: string, max = 100) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
};

/** One entry as terminal lines, or null for entries with nothing to show. */
export function render(entry: Entry): string | null {
  if (entry.type === "meta") return dim(`— ${entry.role}${entry.branch ? ` on ${entry.branch}` : ""} (${entry.model || "default model"})`);
  if (entry.type === "summary") return dim(`— compacted: ${firstLine(entry.text)}`);
  const { role, content } = entry.message;
  if (typeof content === "string") return role === "user" ? `${bold(">")} ${content}` : content;
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "text") lines.push(role === "user" ? `${bold(">")} ${block.text}` : block.text);
    else if (block.type === "tool_use") lines.push(dim(`▸ ${block.name} ${firstLine(JSON.stringify(block.input))}`));
    else if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      lines.push(dim(`  ${block.is_error ? "error: " : ""}${firstLine(text)}`));
    }
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * Print everything in the transcript, then keep printing new entries until
 * `stop` resolves. Reads by byte offset so a partial trailing line waits for
 * its newline.
 */
export async function follow(path: string, out: (s: string) => void, stop: Promise<void>, intervalMs = 300): Promise<void> {
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
      for (const line of text.slice(0, end).split("\n")) {
        if (!line.trim()) continue;
        try {
          const rendered = render(JSON.parse(line) as Entry);
          if (rendered) out(rendered);
        } catch {
          // partial or foreign line
        }
      }
    } finally {
      await fh.close();
    }
  }

  while (!done) {
    await drain();
    await Bun.sleep(intervalMs);
  }
  await drain();
}
