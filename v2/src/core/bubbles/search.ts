// Finding the right node and the right lines inside it, in one pass and without a model: every current entry is a
// document, indexed with its node's title, summary and keywords in front of it (an entry reading "the rule was
// restored" is unfindable alone), and node summaries are documents too, so one query reaches every level of the
// tree. Identifiers (#26041, PHO-18782, SOME_FLAG) stay whole words. Files are the truth; this runs over them.
import { BRANCHES, OVERVIEW, type MemoryNode } from "./nodes";

export interface Hit { id: string; title: string; summary: string; revision: number; score: number; entries: { n: number; text: string }[] }

const STOP = new Set("the a an and or of to in on for with is are was were be been it its this that these those as at by from what when where which who why how does did do can should would will not no yes we you i our your they them their has have had about into than then there here if so".split(" "));
const stem = (word: string) => word.length > 4 ? word.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, "") : word;
/** Words of a text: whole identifiers plus their parts, lightly stemmed. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/#\d+|[a-z0-9]+(?:[._/-][a-z0-9]+)*/g) ?? []) {
    const parts = raw.replace(/^#/, "").split(/[._/-]/).filter(Boolean);
    if (parts.length > 1 || raw.startsWith("#")) out.push(raw);
    for (const part of parts) if (!STOP.has(part) && (part.length > 1 || /\d/.test(part))) out.push(stem(part));
  }
  return out;
}

interface Doc { node: MemoryNode; n: number; terms: Map<string, number>; length: number }
function doc(node: MemoryNode, n: number, text: string): Doc {
  const terms = new Map<string, number>();
  const all = tokens(text);
  for (const term of all) terms.set(term, (terms.get(term) ?? 0) + 1);
  return { node, n, terms, length: all.length };
}
/** The best nodes for any of the phrasings, each with its best current entries. Empty when nothing matches. */
export function searchNodes(nodes: MemoryNode[], queries: string[], limit = 5, perNode = 3): Hit[] {
  const docs: Doc[] = [];
  for (const node of nodes) {
    const context = `${node.title}. ${node.summary} ${node.keywords.join(" ")} ${node.id.replaceAll("/", " ")}`;
    docs.push(doc(node, -1, `${context} ${context}`));
    node.entries.forEach((entry, n) => { if (!entry.retired) docs.push(doc(node, n, `${context} ${entry.text}`)); });
  }
  if (!docs.length) return [];
  const mean = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const frequency = new Map<string, number>();
  for (const d of docs) for (const term of d.terms.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const wanted = queries.map(q => [...new Set(tokens(q))]).filter(terms => terms.length);
  const scoreOf = (d: Doc) => Math.max(0, ...wanted.map(terms => terms.reduce((sum, term) => {
    const tf = d.terms.get(term) ?? 0;
    if (!tf) return sum;
    const idf = Math.log(1 + (docs.length - frequency.get(term)! + 0.5) / (frequency.get(term)! + 0.5));
    return sum + idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.length / mean));
  }, 0)));
  const byNode = new Map<string, { node: MemoryNode; own: number; entries: { n: number; text: string; score: number }[] }>();
  for (const d of docs) {
    const score = scoreOf(d);
    if (score <= 0) continue;
    const found = byNode.get(d.node.id) ?? { node: d.node, own: 0, entries: [] };
    if (d.n < 0) found.own = score; else found.entries.push({ n: d.n, text: d.node.entries[d.n]!.text, score });
    byNode.set(d.node.id, found);
  }
  return [...byNode.values()].map(found => {
    const entries = found.entries.sort((a, b) => b.score - a.score).slice(0, perNode);
    return { id: found.node.id, title: found.node.title, summary: found.node.summary, revision: found.node.revision,
      score: found.own + (entries[0]?.score ?? 0) + 0.25 * entries.slice(1).reduce((sum, e) => sum + e.score, 0),
      entries: entries.map(({ n, text }) => ({ n, text })) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
export function renderHits(hits: Hit[]): string {
  return hits.map(hit => [`${hit.id} (rev ${hit.revision}) — ${hit.summary}`, ...hit.entries.map(e => `  [${e.n}] ${e.text}`)].join("\n")).join("\n");
}

/** What every member carries in context: one line per node while that fits, else the busiest branches shrink to
 * their newest nodes plus a count, so the index stays inside `budget` characters however large memory grows. */
export function renderIndex(nodes: MemoryNode[], budget = 9000): string {
  const branches = Object.keys(BRANCHES).map(branch => ({ branch, nodes: nodes.filter(n => n.id.startsWith(`${branch}/`)) })).filter(b => b.nodes.length);
  const shown = new Map(branches.map(b => [b.branch, b.nodes.length]));
  const row = (n: MemoryNode) => `- ${n.id} — ${n.summary}`;
  const render = () => branches.map(({ branch, nodes: all }) => {
    const keep = shown.get(branch)!, newest = [...all].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, keep).sort((a, b) => a.id.localeCompare(b.id));
    return [`## ${branch} — ${BRANCHES[branch]} (${all.length} node${all.length === 1 ? "" : "s"}${keep < all.length ? `, newest ${keep} shown; memory list "${branch}" for the rest` : ""})`, ...newest.map(row)].join("\n");
  }).join("\n");
  let text = render();
  while (text.length > budget) {
    const widest = [...shown.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!widest || widest[1] <= 3) break;
    shown.set(widest[0], Math.max(3, Math.floor(widest[1] * 0.7)));
    text = render();
  }
  return text;
}
export function overviewText(nodes: MemoryNode[]): string {
  const node = nodes.find(n => n.id === OVERVIEW);
  return node ? [node.summary, ...node.entries.filter(e => !e.retired).map(e => `- ${e.text}`)].join("\n") : "";
}
