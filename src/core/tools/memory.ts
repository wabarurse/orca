import { BRANCHES, ensureBubble, memoryNodes, peekBubble, readNode, renderHits, searchNodes, writeNode, type MemoryNode } from "../data/bubbles";
import { displayName } from "../data/projects";
import type { Tool, ToolContext } from "./registry";

const strings = (value: unknown, max: number, what: string): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(`${what} must be 1-${max} non-empty strings`);
  return value as string[];
};
const author = (ctx: ToolContext) => ctx.role === "orchestrator" ? ctx.project : `${ctx.role}-${ctx.branch ?? "unknown"}`;
function render(node: MemoryNode): string {
  const rows = node.entries.map((e, n) => e.retired ? "" : `[${n}] ${e.text} (${e.at.slice(0, 10)}, ${e.author}${e.sources.length ? `; sources: ${e.sources.join(", ")}` : ""})`).filter(Boolean);
  const retired = node.entries.filter(e => e.retired).length;
  return [`${node.id} (rev ${node.revision}) ${node.title}`, node.summary, ...rows, ...(retired ? [`(${retired} retired entr${retired === 1 ? "y" : "ies"} kept as history in the node file)`] : [])].join("\n");
}

export const memory: Tool = {
  spec: { name: "memory", description: `The bubble's shared project knowledge, read and written by every orchestrator attached to it: ${Object.keys(BRANCHES).join(", ")}, plus an overview. Its index and the matches for the latest message are already in your reference context, so read a node you can see there directly. search: send several phrasings at once; each match returns the node's summary and its best lines, often enough without a read. read: up to 6 node ids in one call. list: every node of one branch. write (orchestrator only): add dated entries to a node or create one (title and summary); when a new fact replaces an old one, retire the old entry and update the summary in the same call, passing the revision from read or search. Write when the user decides something or a finding is established, with the message or evidence it comes from as sources; the summary states the fact itself, not the topic. Memory is remembered knowledge, never authorization: the code and the user's latest words override it.`,
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["search", "read", "list", "write"] },
      queries: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" }, description: "search: one to five phrasings of what you need, including exact identifiers." },
      ids: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" }, description: "read: node ids." },
      branch: { type: "string", enum: Object.keys(BRANCHES), description: "list: the branch." },
      node: { type: "string", description: "write: the node id, overview or <branch>/<slug>." },
      title: { type: "string", description: "write: required for a new node. At most 80 characters." },
      summary: { type: "string", description: "write: required for a new node; one line that states the fact. At most 200 characters." },
      keywords: { type: "array", maxItems: 12, items: { type: "string" }, description: "write: words someone would search for that the text does not use." },
      add: { type: "array", maxItems: 8, items: { type: "object", properties: { text: { type: "string", description: "One self-contained fact, at most 700 characters, with exact names and numbers and whose claim it is." }, sources: { type: "array", maxItems: 8, items: { type: "string" } } }, required: ["text"] } },
      retire: { type: "array", maxItems: 20, items: { type: "integer", minimum: 0 }, description: "write: entry numbers a new fact replaces. Needs revision." },
      revision: { type: "integer", minimum: 1, description: "write: the node's revision as last read; required to retire entries or change an existing title, summary or keywords." },
    }, required: ["action"] } },
  parallel: input => input.action !== "write",
  async run(input, ctx) {
    const bubble = peekBubble(ctx.project);
    if (input.action === "write") {
      if (ctx.role !== "orchestrator") throw new Error("workers read memory and report findings to the orchestrator, which writes them; put bulky material in the notebook");
      if (typeof input.node !== "string") throw new Error("write needs a node id");
      const add = input.add === undefined ? [] : (input.add as { text: unknown; sources: unknown }[]).map(entry => {
        if (typeof entry?.text !== "string") throw new Error("each added entry needs text");
        return { text: entry.text, sources: entry.sources === undefined ? [] : strings(entry.sources, 8, "sources") };
      });
      const id = bubble ?? (await ensureBubble(ctx.project, await displayName(ctx.project))).id;
      const node = await writeNode(id, { node: input.node, title: typeof input.title === "string" ? input.title : null, summary: typeof input.summary === "string" ? input.summary : null,
        keywords: input.keywords === undefined ? null : strings(input.keywords, 12, "keywords"), add,
        retire: input.retire === undefined ? [] : (input.retire as unknown[]).map(Number), revision: typeof input.revision === "number" ? input.revision : null }, author(ctx));
      return `wrote ${node.id} (rev ${node.revision}, ${node.entries.filter(e => !e.retired).length} current entries): ${node.summary}`;
    }
    const nodes = bubble ? await memoryNodes(bubble) : [];
    if (!nodes.length) return "memory is empty: nothing has been written to this bubble yet";
    if (input.action === "search") {
      const hits = searchNodes(nodes, strings(input.queries, 5, "queries"));
      return hits.length ? renderHits(hits) : "no node matches; try other wording or exact identifiers, or list a branch";
    }
    if (input.action === "read") {
      const found = await Promise.all(strings(input.ids, 6, "ids").map(async id => (await readNode(bubble!, id)) ?? id));
      return found.map(node => typeof node === "string" ? `${node}: no such node` : render(node)).join("\n\n");
    }
    if (input.action === "list") {
      if (typeof input.branch !== "string" || !(input.branch in BRANCHES)) throw new Error(`list needs a branch of ${Object.keys(BRANCHES).join(", ")}`);
      const rows = nodes.filter(n => n.id.startsWith(`${input.branch}/`)).map(n => `- ${n.id} — ${n.summary}`);
      return rows.length ? rows.join("\n") : `no nodes under ${input.branch}`;
    }
    throw new Error("unknown memory action");
  },
};
