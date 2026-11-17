// What an agent is shown of its bubble at each request boundary, as named reference sections (only a changed section
// is re-sent, so the stable part stays in the provider's prompt cache). An orchestrator carries the behavior lines,
// the overview, the memory index and the notebook's titles; a worker carries the behavior lines and the overview and
// searches for the rest. Both get the memory matches for the latest message, found locally before the model runs.
import { join } from "node:path";
import { behavior, bubbleDir, bubbleMembers, listPages, memoryNodes, overviewText, peekBubble, readBubble, renderHits, renderIndex, renderPages, searchNodes } from "../bubbles";
import { displayName } from "../projects";
import { workingContext } from "./knowledge";

export type ContextRole = "orchestrator" | "worker" | "reviewer";
const HITS = 4, LINES = 2;

/** Hits worth showing unasked: the best one must match clearly, the rest must be close to it. */
export function lookup(nodes: Parameters<typeof searchNodes>[0], query: string): string {
  if (!query.trim()) return "";
  const hits = searchNodes(nodes, [query], HITS, LINES);
  const best = hits[0]?.score ?? 0;
  return best < 4 ? "" : renderHits(hits.filter(hit => hit.score >= best * 0.6));
}

export async function bubbleContext(project: string, query: string, role: ContextRole): Promise<Record<string, string>> {
  const id = peekBubble(project);
  const bubble = id ? await readBubble(id) : null;
  if (!bubble) return {};
  const [nodes, lines, pages] = await Promise.all([memoryNodes(bubble.id), behavior(bubble.id), listPages(bubble.id)]);
  const others = bubbleMembers(bubble.id).filter(member => member !== project);
  if (!nodes.length && !lines.length && !pages.length && !others.length) return {};
  const overview = overviewText(nodes), hits = lookup(nodes, query);
  const head = [`Bubble "${bubble.name}": the shared knowledge of ${others.length + 1} orchestrator${others.length ? "s" : ""}. Its nodes are markdown files under ${join(bubbleDir(bubble.id), "memory")}.`,
    role === "orchestrator" ? "Use it before investigating again. When the user decides something or a finding is established, write it to memory in that turn, and retire the entry it replaces. Put bulky output in the notebook and cite the page id."
      : "Use it before re-deriving what is already known. Save bulky results with notebook put and cite the page id in your report; the orchestrator writes memory.",
    ...(lines.length ? ["Behavior (how the user wants agents in this bubble to act; follow it):", ...lines.map(line => `- ${line.text}`)] : []),
    ...(overview ? ["Overview:", overview] : [])];
  const sections: Record<string, string> = {};
  if (role === "orchestrator") {
    sections.bubble = [...head,
      ...(nodes.length ? ["Memory index (node id — summary). Read nodes with memory read, several ids in one call; search when the index does not show what you need:", renderIndex(nodes)] : ["Memory is empty so far."]),
      ...(pages.length ? ["Notebook (page id — title: summary):", renderPages(pages, 15)] : [])].join("\n");
    if (others.length) {
      const rows = await Promise.all(others.map(async other => `- ${await displayName(other)} (${other}): ${((await workingContext(other)).goal ?? "no goal recorded").replace(/\s+/g, " ").slice(0, 200)}`));
      sections["bubble-orcs"] = `Other orchestrators attached to this bubble and what each is working on:\n${rows.join("\n")}`;
    }
  } else sections.bubble = [...head, `Memory holds ${nodes.length} node${nodes.length === 1 ? "" : "s"} and the notebook ${pages.length} page${pages.length === 1 ? "" : "s"}: use memory search and notebook list or query when your task needs them.`].join("\n");
  if (hits) sections["bubble-hits"] = `Memory matches for the latest message, searched for you (node id, revision, summary, then its best lines; read a node only when these lines are not enough):\n${hits}`;
  return sections;
}
