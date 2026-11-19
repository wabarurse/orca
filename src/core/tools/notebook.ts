import { ensureBubble, listPages, peekBubble, putPage, queryPage, readPage, renderPages } from "../data/bubbles";
import { displayName } from "../data/projects";
import { filePath } from "./files";
import type { Tool } from "./registry";

export const notebook: Tool = {
  spec: { name: "notebook", description: "The bubble's notebook: bulky material kept out of everyone's context (tool output, reports, documents, tables), shared by the bubble's orchestrators and their workers. Only titles and one-line summaries are listed; content is fetched on demand. put: save text or a file from your workspace or evidence folder with a title and a summary saying what it holds. list: the pages, most recently used first. read: a line range of a page. query: only the lines matching a pattern, so a large page is never loaded whole. Cite a page id as a source when you write knowledge. The notebook holds a limited number of pages; the least recently used is archived first and a read restores it for a while.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "put", "read", "query"] },
      id: { type: "string", description: "read/query: the page id." },
      title: { type: "string", description: "put: at most 120 characters." },
      summary: { type: "string", description: "put: one line saying what the page holds, at most 240 characters." },
      content: { type: "string", description: "put: the text to save. Mutually exclusive with path." },
      path: { type: "string", description: "put: a file in your workspace or evidence folder to save instead of content." },
      start_line: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 2000 },
      pattern: { type: "string", description: "query: a regular expression (case-insensitive), else plain text." },
    }, required: ["action"] } },
  parallel: input => input.action === "list",
  async run(input, ctx) {
    const who = ctx.role === "orchestrator" ? ctx.project : `${ctx.role}-${ctx.branch ?? "unknown"}`;
    if (input.action === "put") {
      if ((input.content === undefined) === (input.path === undefined)) throw new Error("put needs exactly one of content or path");
      const content = typeof input.content === "string" ? input.content : await Bun.file(await filePath(input.path, ctx)).text();
      const bubble = peekBubble(ctx.project) ?? (await ensureBubble(ctx.project, await displayName(ctx.project))).id;
      const page = await putPage(bubble, { title: String(input.title ?? ""), summary: String(input.summary ?? ""), content }, who);
      return `saved ${page.id} "${page.title}" (${page.bytes} bytes)`;
    }
    const bubble = peekBubble(ctx.project);
    if (!bubble) return "the notebook is empty";
    if (input.action === "list") { const pages = await listPages(bubble); return pages.length ? renderPages(pages, 100) : "the notebook is empty"; }
    if (typeof input.id !== "string") throw new Error("read and query need a page id");
    if (input.action === "read") return readPage(bubble, input.id, typeof input.start_line === "number" ? input.start_line : 1, typeof input.lines === "number" ? input.lines : 400);
    if (input.action === "query") return queryPage(bubble, input.id, String(input.pattern ?? ""));
    throw new Error("unknown notebook action");
  },
};
