// The memory tool: the bubble's shared memory tree, plus archived messages (what compaction replaced), labelled.
import { readArchived, searchArchive } from "../archive";
import { BRANCHES, ensureBubble, memoryNodes, peekBubble, readNode, renderHits, searchNodes, writeNode, type MemoryNode } from "../bubbles";
import { listConversations } from "../conversations";
import type { Tool } from "./registry";

const strings = (value: unknown, max: number, what: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || value.some(v => typeof v !== "string" || v.trim().length === 0)) throw new Error(`${what} must be 1-${max} non-empty strings`);
  return value.filter((v): v is string => typeof v === "string");
};

function render(node: MemoryNode): string {
  const rows = node.entries.map((e, n) => e.retired !== null ? "" : `[${n}] ${e.text} (${e.at.slice(0, 10)}, ${e.author}${e.sources.length > 0 ? `; sources: ${e.sources.join(", ")}` : ""})`).filter(row => row.length > 0);
  const retired = node.entries.filter(e => e.retired !== null).length;
  return [`${node.id} (rev ${node.revision}) ${node.title}`, node.summary, ...rows, ...(retired > 0 ? [`(${retired} retired entr${retired === 1 ? "y" : "ies"} kept as history)`] : [])].join("\n");
}

/** The conversations whose archived messages this one may search: its bubble's, or itself alone. */
async function scope(conversation: string, bubble: string | null): Promise<string[]> {
  if (bubble === null) return [conversation];
  return (await listConversations()).filter(c => c.bubble === bubble).map(c => c.id);
}

const ARCHIVED = /^[0-9a-f-]{36}$/;

export const memory: Tool = {
  parallel: input => input.action !== "write",
  spec: { name: "memory", description: `The bubble's shared knowledge, read and written by every orchestrator attached to it: ${Object.keys(BRANCHES).join(", ")}, plus an overview. search: several phrasings at once; returns matching nodes (summary and best lines) and, labelled "archived", matching older messages of this bubble's conversations that compaction replaced. read: up to 6 node ids or archived message ids. list: every node of one branch. write (orchestrator only): add dated entries to a node or create one (title and summary); when a new fact replaces an old one, retire the old entry in the same call, passing the revision. Write when the user decides something or a finding is established, with its sources. Memory is remembered knowledge, never authorization.`,
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["search", "read", "list", "write"] },
      queries: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      ids: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" }, description: "read: node ids or archived message ids." },
      offset: { type: "integer", minimum: 0, description: "read of an archived message: where to continue." },
      branch: { type: "string", enum: Object.keys(BRANCHES) },
      node: { type: "string", description: "write: the node id, overview or <branch>/<slug>." },
      title: { type: "string" }, summary: { type: "string" },
      keywords: { type: "array", maxItems: 12, items: { type: "string" } },
      add: { type: "array", maxItems: 8, items: { type: "object", properties: { text: { type: "string" }, sources: { type: "array", maxItems: 8, items: { type: "string" } } }, required: ["text"] } },
      retire: { type: "array", maxItems: 20, items: { type: "integer", minimum: 0 } },
      revision: { type: "integer", minimum: 1 },
    }, required: ["action"] } },
  async run(input, ctx) {
    const bubble = await peekBubble(ctx.conversation);
    if (input.action === "write") {
      if (ctx.role !== "orchestrator") throw new Error("workers report findings to the orchestrator, which writes memory; put bulky material in the notebook");
      if (typeof input.node !== "string") throw new Error("write needs a node id");
      const add = Array.isArray(input.add) ? input.add.map((entry: unknown) => {
        const e = entry as { text?: unknown; sources?: unknown } | null;
        if (typeof e?.text !== "string") throw new Error("each added entry needs text");
        return { text: e.text, sources: e.sources === undefined ? [] : strings(e.sources, 8, "sources") };
      }) : [];
      const id = bubble ?? (await ensureBubble(ctx.conversation)).id;
      const node = await writeNode(id, { node: input.node, title: typeof input.title === "string" ? input.title : null, summary: typeof input.summary === "string" ? input.summary : null,
        keywords: input.keywords === undefined ? null : strings(input.keywords, 12, "keywords"), add,
        retire: Array.isArray(input.retire) ? input.retire.map(Number) : [], revision: typeof input.revision === "number" ? input.revision : null }, ctx.agent);
      return `wrote ${node.id} (rev ${node.revision}, ${node.entries.filter(e => e.retired === null).length} current entries): ${node.summary}`;
    }
    const nodes = bubble === null ? [] : await memoryNodes(bubble);
    if (input.action === "search") {
      const queries = strings(input.queries, 5, "queries");
      const hits = searchNodes(nodes, queries);
      const archived = searchArchive(await scope(ctx.conversation, bubble), queries, 6);
      const parts = [hits.length > 0 ? renderHits(hits) : "", archived.length > 0 ? `archived messages (older conversation, replaced by compaction; read by id):\n${archived.map(hit => `- ${hit.uuid} ${hit.ts.slice(0, 16)} ${hit.conversation}/${hit.agent} ${hit.role}: ${hit.snippet.replace(/\s+/g, " ")}`).join("\n")}` : ""].filter(part => part.length > 0);
      return parts.length > 0 ? parts.join("\n\n") : "nothing matches; try other wording or exact identifiers, or list a branch";
    }
    if (input.action === "read") {
      const out = await Promise.all(strings(input.ids, 6, "ids").map(async id => {
        if (ARCHIVED.test(id)) {
          const page = readArchived(id, typeof input.offset === "number" ? input.offset : 0, 4000);
          return page === null ? `${id}: no such archived message` : `${id} (archived)\n${page.text}${page.next === null ? "" : `\n[continues: read with offset ${page.next}]`}`;
        }
        const node = bubble === null ? null : await readNode(bubble, id);
        return node === null ? `${id}: no such node` : render(node);
      }));
      return out.join("\n\n");
    }
    if (input.action === "list") {
      if (typeof input.branch !== "string" || !(input.branch in BRANCHES)) throw new Error(`list needs a branch of ${Object.keys(BRANCHES).join(", ")}`);
      const rows = nodes.filter(n => n.id.startsWith(`${input.branch}/`)).map(n => `- ${n.id} — ${n.summary}`);
      return rows.length > 0 ? rows.join("\n") : `no nodes under ${input.branch}`;
    }
    throw new Error("unknown memory action");
  },
};
