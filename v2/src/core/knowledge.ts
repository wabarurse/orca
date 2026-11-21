// The reference sections an agent sees at each request boundary: behavior lines (user-wide and the bubble's),
// the bubble's memory (index for the orchestrator, overview for workers, matches for the latest message),
// repository instructions and the skill list. Only a changed section is re-sent (loop/context.ts).
import { join } from "node:path";
import { behavior, bubbleDir, listPages, memoryNodes, overviewText, readBubble, renderHits, renderIndex, renderPages, searchNodes } from "./bubbles";
import { listConversations, readConversation } from "./conversations";
import { discoverSkills, repositoryInstructions, SKILL_RESULT_LIMIT } from "./instructions";
import type { Role } from "./types";

function lookup(nodes: Parameters<typeof searchNodes>[0], query: string): string {
  if (query.trim().length === 0) return "";
  const hits = searchNodes(nodes, [query], 4, 2);
  const best = hits[0]?.score ?? 0;
  return best < 4 ? "" : renderHits(hits.filter(hit => hit.score >= best * 0.6));
}

export async function referenceSections(input: { conversation: string; role: Role; cwd: string; trusted: boolean; pluginSkills: string[]; query: string }): Promise<Record<string, string>> {
  const sections: Record<string, string> = {};
  const meta = await readConversation(input.conversation);
  const bubble = meta?.bubble == null ? null : await readBubble(meta.bubble);
  const user = await behavior({ kind: "user" });
  const local = bubble === null ? [] : await behavior({ kind: "bubble", bubble: bubble.id });
  const line = (l: { text: string; confidence: string }): string => `- ${l.text}${l.confidence === "tentative" ? " (tentative)" : ""}`;
  if (user.length > 0 || local.length > 0) sections.behavior = ["How the user wants agents to act (follow it):", ...user.map(line), ...local.map(line)].join("\n");
  if (bubble !== null) {
    const [nodes, pages] = await Promise.all([memoryNodes(bubble.id), listPages(bubble.id)]);
    const others = (await listConversations()).filter(c => c.bubble === bubble.id && c.id !== input.conversation);
    const overview = overviewText(nodes);
    const head = [`Bubble "${bubble.name}": shared knowledge of ${others.length + 1} conversation${others.length > 0 ? "s" : ""}, as markdown files under ${join(bubbleDir(bubble.id), "memory")}.`, ...(overview.length > 0 ? ["Overview:", overview] : [])];
    sections.bubble = input.role === "orchestrator"
      ? [...head, ...(nodes.length > 0 ? ["Memory index (node id — summary); read nodes with memory read:", renderIndex(nodes)] : ["Memory is empty so far."]),
        ...(pages.length > 0 ? ["Notebook (page id — title: summary):", renderPages(pages, 15)] : []),
        ...(others.length > 0 ? ["Other conversations in this bubble:", ...others.map(c => `- ${c.name} (${c.id})`)] : [])].join("\n")
      : [...head, `Memory holds ${nodes.length} node${nodes.length === 1 ? "" : "s"} and the notebook ${pages.length} page${pages.length === 1 ? "" : "s"}: use memory search and notebook when your task needs them.`].join("\n");
    const hits = lookup(nodes, input.query);
    if (hits.length > 0) sections["bubble-hits"] = `Memory matches for the latest message (read a node only when these lines are not enough):\n${hits}`;
  }
  if (input.trusted) sections.instructions = await repositoryInstructions(input.cwd, input.cwd, false);
  const skills = await discoverSkills(input.cwd, input.trusted, input.pluginSkills);
  if (skills.length > 0) sections.skills = `Skills (${skills.length}). Before inventing a workflow, use skill({search: "keywords"}) or skill({name}). Preview: ${JSON.stringify(skills.slice(0, SKILL_RESULT_LIMIT).map(({ name, description }) => ({ name, description })))}`;
  return sections;
}
