// Provenance for explicit preferences: which retained human message a `remember`
// source refers to. Candidates come only from human input (inbox messages sent as
// "user": typed prompts, Questions answers, feedback to an agent), never from
// assistant, tool, worker or runtime text. A source names a candidate by its id,
// by containing its id, or by quoting its text; it resolves to the canonical id.

/** One retained human message: the inbox inputId (or delivery id) and its text. */
export interface HumanMessage { id: string; text: string; at: string }

/** A source traced to a human message: its canonical id and a short quote of it. */
export interface ResolvedSource { id: string; quote: string }

/** Shortest quote (normalized characters) that may identify a message by containment;
 * a shorter quote must equal the whole message. */
const MIN_QUOTE = 12;
const QUOTE_MAX = 160;

/** Lowercase, quotes dropped, whitespace collapsed: free-text quotes still match. */
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/["'`\u2018\u2019\u201c\u201d]/g, "").replace(/\s+/g, " ").trim();

/** The human part of a message: a Questions answer quotes the assistant's question, which never counts. */
export function humanText(text: string): string {
  const answer = /^\[[\w.-]+\] answer to "[\s\S]*": ([\s\S]*)$/.exec(text);
  return answer ? answer[1]! : text;
}

/** The quoted passages of a free-text source, or the whole source after an attribution such as `User, 2026-10-28:`. */
function fragments(source: string): string[] {
  const quoted = [...source.matchAll(/"([^"]+)"|\u201c([^\u201d]+)\u201d|\u2018([^\u2019]+)\u2019/g)].map(m => m[1] ?? m[2] ?? m[3] ?? "");
  const parts = quoted.length ? quoted : [source.replace(/^[^:"\u201c]{0,80}:\s+/, "")];
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Whether one quoted passage (pieces split at an ellipsis) is in `text`. */
function quotes(passage: string, text: string): boolean {
  const pieces = passage.split(/\.\.\.|\u2026/).map(normalize).filter(Boolean);
  if (!pieces.length) return false;
  if (pieces.length === 1 && pieces[0] === text) return true;
  return pieces.reduce((n, p) => n + p.length, 0) >= MIN_QUOTE && pieces.every(p => text.includes(p));
}

const short = (s: string, max = QUOTE_MAX) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/**
 * The human message `source` refers to, newest first: an exact id, a source that
 * contains an id, or a source whose every quoted passage is in one message's
 * human text. Null when none does.
 */
export function resolveHumanSource(source: string, candidates: HumanMessage[]): ResolvedSource | null {
  const newest = [...candidates].reverse();
  const quote = (m: HumanMessage) => short(humanText(m.text));
  const exact = newest.find(m => m.id === source.trim());
  if (exact) return { id: exact.id, quote: quote(exact) };
  const named = newest.find(m => m.id.length >= 8 && source.includes(m.id));
  if (named) return { id: named.id, quote: quote(named) };
  const passages = fragments(source);
  if (!passages.length) return null;
  const quoted = newest.find(m => { const text = normalize(humanText(m.text)); return passages.every(p => quotes(p, text)); });
  return quoted ? { id: quoted.id, quote: short(passages.join(" … ")) } : null;
}

/** The newest candidates as `id — "preview"` lines, for a refusal that says what a source may be. */
export function sourceChoices(candidates: HumanMessage[], limit = 8): string {
  const rows = candidates.slice(-limit).reverse().map(m => `- ${m.id} (${m.at}): "${short(humanText(m.text), 80)}"`);
  return rows.length ? rows.join("\n") : "- (no human messages are retained for this project yet)";
}
