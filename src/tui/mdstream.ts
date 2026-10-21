// Markdown arriving in chunks, cut into blocks as soon as each is complete:
// a paragraph, heading or list line at its newline, a code block at its
// closing fence, a table at the first line that is not a row. Until then the
// raw text waits in `pending` (shown as is in the live region). The blocks are
// raw markdown for markdown.ts `renderBlock`, so a page can keep the source and
// lay it out again at another width. Feeding a text in any chunks gives the
// same blocks as `takeBlocks(sourceLines(text), true)`.

import { isBlank, takeBlocks } from "./markdown";

export class MarkdownStream {
  /** Complete lines not yet in a finished block. */
  private lines: string[] = [];
  /** The line still being written. */
  private partial = "";
  /** Set once a non-blank line has arrived: blank lines before it are dropped. */
  private started = false;

  /** Add a chunk; returns the blocks it completed. */
  feed(chunk: string): string[] {
    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop()!;
    for (const line of parts) this.push(line);
    return this.take(false);
  }

  /** End of the reply: everything held becomes blocks (an unclosed code block too), and the next reply starts afresh. */
  flush(): string[] {
    if (this.partial) this.push(this.partial);
    this.partial = "";
    const blocks = this.take(true);
    this.started = false;
    return blocks;
  }

  /** The raw text held back: an unfinished block and the line being written. */
  get pending(): string {
    const first = this.lines.findIndex((l) => !isBlank(l));
    const held = first === -1 ? [] : this.lines.slice(first);
    return [...held, ...(this.partial ? [this.partial] : [])].join("\n");
  }

  private push(line: string): void {
    if (!this.started && isBlank(line)) return;
    this.started = true;
    this.lines.push(line);
  }

  private take(end: boolean): string[] {
    const { blocks, used } = takeBlocks(this.lines, end);
    this.lines = end ? [] : this.lines.slice(used);
    return blocks;
  }
}
