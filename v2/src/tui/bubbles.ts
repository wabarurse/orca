import { homedir } from "node:os";
import { basename } from "node:path";
import { bubbleServes, listBubbles, memoryNodes, OVERVIEW, type Bubble } from "../core/bubbles";
import { listConversations, type Conversation } from "../core/conversations";
import type { Row, Section } from "../core/plugins/types";

export type BubbleEntry = { bubble: Bubble; nodes: number; overview: string | null; conversations: Conversation[]; here: boolean };
export type BubbleTarget = { kind: "bubble"; id: string } | { kind: "conversation"; id: string } | { kind: "none" };

const NO_BUBBLE = "no bubble";

export function bubbleFolder(bubble: Bubble): string {
  if (bubble.directory === null) return "no folder";
  const home = homedir();
  return bubble.directory === home || bubble.directory.startsWith(`${home}/`) ? `~${bubble.directory.slice(home.length)}` : bubble.directory;
}

export async function bubbleEntries(directory: string): Promise<{ entries: BubbleEntry[]; loose: Conversation[] }> {
  const [bubbles, conversations] = await Promise.all([listBubbles(), listConversations()]);
  const entries = await Promise.all(bubbles.map(async (bubble): Promise<BubbleEntry> => {
    const nodes = await memoryNodes(bubble.id);
    return { bubble, nodes: nodes.filter(n => n.id !== OVERVIEW).length, overview: nodes.find(n => n.id === OVERVIEW)?.summary ?? null,
      conversations: conversations.filter(c => c.bubble === bubble.id), here: bubbleServes(bubble, directory) };
  }));
  const known = new Set(bubbles.map(b => b.id));
  entries.sort((a, b) => a.here !== b.here ? (a.here ? -1 : 1) : b.nodes !== a.nodes ? b.nodes - a.nodes : a.bubble.name.localeCompare(b.bubble.name));
  return { entries, loose: conversations.filter(c => c.directory === directory && (c.bubble === null || !known.has(c.bubble))) };
}

const conversationRow = (c: Conversation, current: string, last: boolean): Row => ({ id: `conversation:${c.id}`, name: `  ${last ? "└─" : "├─"} ${c.name}`,
  status: c.id === current ? "open" : "", info: `${basename(c.directory)} · ${c.createdAt.slice(0, 10)}`, tone: c.id === current ? "good" : "normal" });

const children = (list: Conversation[], current: string): Row[] => list.map((c, i) => conversationRow(c, current, i === list.length - 1));

export function bubbleRows(found: { entries: BubbleEntry[]; loose: Conversation[] }, current: string): Row[] {
  const rows = found.entries.flatMap(e => [
    { id: `bubble:${e.bubble.id}`, name: e.bubble.name, status: `${e.nodes} node${e.nodes === 1 ? "" : "s"}`,
      info: `${e.conversations.length} chat${e.conversations.length === 1 ? "" : "s"}${e.here ? "" : ` · ${bubbleFolder(e.bubble)}`}`, tone: e.conversations.some(c => c.id === current) ? "good" : "normal" } satisfies Row,
    ...children(e.conversations, current)]);
  if (found.loose.length === 0) return rows;
  return [...rows, { id: "none", name: NO_BUBBLE, status: "", info: `${found.loose.length} chat${found.loose.length === 1 ? "" : "s"}`, tone: "dim" }, ...children(found.loose, current)];
}

export function bubbleTarget(row: Row | undefined): BubbleTarget {
  if (row === undefined || row.id === "none") return { kind: "none" };
  const [kind = "", id = ""] = row.id.split(":");
  return kind === "bubble" ? { kind: "bubble", id } : kind === "conversation" ? { kind: "conversation", id } : { kind: "none" };
}

export function bubbleDetails(found: { entries: BubbleEntry[]; loose: Conversation[] }, row: Row): Section[] {
  const target = bubbleTarget(row);
  if (target.kind === "bubble") {
    const e = found.entries.find(x => x.bubble.id === target.id);
    if (e === undefined) return [];
    return [{ title: "Bubble", lines: [`id ${e.bubble.id}`, `folder ${e.bubble.directory ?? "none"}`, `created ${e.bubble.createdAt.slice(0, 10)}`, `${e.nodes} memory nodes`,
      ...(e.overview === null ? [] : [`overview ${e.overview}`])] },
    { title: "Chats", lines: e.conversations.length === 0 ? ["none yet: Enter starts one here"] : e.conversations.map(c => `${c.name} · ${c.directory}`) }];
  }
  if (target.kind === "conversation") {
    const c = [...found.entries.flatMap(e => e.conversations), ...found.loose].find(x => x.id === target.id);
    if (c === undefined) return [];
    return [{ title: "Chat", lines: [`id ${c.id}`, `folder ${c.directory}`, `model ${c.model ?? "default"}`, `created ${c.createdAt}`] }];
  }
  return [];
}

export type BubbleChoice = { kind: "new" } | { kind: "join"; id: string } | { kind: "none" };

export async function bubbleChoices(directory: string): Promise<{ options: string[]; choices: BubbleChoice[] }> {
  const { entries } = await bubbleEntries(directory);
  return {
    options: ["New bubble", ...entries.map(e => `${e.bubble.name} · ${e.nodes} nodes · ${e.conversations.length} chats${e.here ? "" : ` · ${bubbleFolder(e.bubble)}`}`), "No bubble (no shared memory)"],
    choices: [{ kind: "new" }, ...entries.map((e): BubbleChoice => ({ kind: "join", id: e.bubble.id })), { kind: "none" }],
  };
}
