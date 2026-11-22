import { ensureBubble, listPages, peekBubble, putPage, queryPage, readPage, renderPages } from "../bubbles";
import { filePath } from "./path";
import { settled, type Tool } from "./registry";

export const notebook: Tool = {
  parallel: input => input.action !== "put",
  spec: { name: "notebook", description: "The bubble's notebook: bulky material kept out of everyone's context (tool output, reports, documents, tables), shared by the bubble's orchestrators and their workers. Only titles and one-line summaries are listed; content is fetched on demand. put: save text or a file from your workspace with a title and a summary saying what it holds. list: the pages, most recently used first. read: a line range of a page. query: only the lines matching a pattern. Cite a page id as a source when you write memory.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "put", "read", "query"] },
      id: { type: "string", description: "read/query: the page id." },
      title: { type: "string", description: "put: at most 120 characters." },
      summary: { type: "string", description: "put: one line saying what the page holds, at most 240 characters." },
      content: { type: "string", description: "put: the text to save. Mutually exclusive with path." },
      path: { type: "string", description: "put: a file in your workspace to save instead of content." },
      start_line: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 2000 },
      pattern: { type: "string", description: "query: a regular expression (case-insensitive), else plain text." },
    }, required: ["action"] } },
  async run(input, ctx) {
    if (input.action === "put") {
      if ((input.content === undefined) === (input.path === undefined)) throw new Error("put needs exactly one of content or path");
      const content = typeof input.content === "string" ? input.content : await Bun.file(settled(await filePath(input.path, ctx))).text();
      const bubble = await peekBubble(ctx.conversation) ?? settled(await ensureBubble(ctx.conversation)).id;
      const page = settled(await putPage(bubble, { title: String(input.title ?? ""), summary: String(input.summary ?? ""), content }, ctx.agent));
      return `saved ${page.id} "${page.title}" (${page.bytes} bytes)`;
    }
    const bubble = await peekBubble(ctx.conversation);
    if (bubble === null) return "the notebook is empty";
    if (input.action === "list") { const pages = await listPages(bubble); return pages.length > 0 ? renderPages(pages, 100) : "the notebook is empty"; }
    if (typeof input.id !== "string") throw new Error("read and query need a page id");
    if (input.action === "read") return settled(await readPage(bubble, input.id, typeof input.start_line === "number" ? input.start_line : 1, typeof input.lines === "number" ? input.lines : 400));
    if (input.action === "query") return settled(await queryPage(bubble, input.id, typeof input.pattern === "string" ? input.pattern : ""));
    throw new Error("unknown notebook action");
  },
};
