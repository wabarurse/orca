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
/** Shortest piece of a quote elided with "…": every piece is itself a real excerpt, never a stitched word or two. */
const MIN_PIECE = 8;
const QUOTE_MAX = 160;

const QUOTE_MARKS = /["'`\u2018\u2019\u201c\u201d]/g;
/** Lowercase, quotes dropped, whitespace collapsed, so free-text quotes still match, with each normalized character's
 * span [from, to) in `s`: a match maps back to the message's own words. */
function normalized(s: string): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [], to: number[] = [];
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!), next = i + ch.length;
    for (const c of ch.normalize("NFKC").toLowerCase().replace(QUOTE_MARKS, "")) {
      if (/\s/.test(c) && (!text || text.endsWith(" "))) continue;
      const out = /\s/.test(c) ? " " : c;
      text += out;
      for (let k = 0; k < out.length; k++) { from.push(i); to.push(next); } // one entry per UTF-16 unit, as indexOf counts
    }
    i = next;
  }
  if (text.endsWith(" ")) { text = text.slice(0, -1); from.pop(); to.pop(); }
  return { text, from, to };
}
const normalize = (s: string) => normalized(s).text;

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

/** The pieces of a source's quoted passages, in order: each passage split at an ellipsis. */
const piecesOf = (passages: string[]) => passages.flatMap(p => p.split(/\.\.\.|\u2026/)).map(normalize).filter(Boolean);

/**
 * Where `pieces` quote `text` (normalized): the span [start, end) from the first piece to the last, or null. One piece
 * must be the whole text or at least MIN_QUOTE characters; several (elided with "…" or quoted separately) must each be
 * at least MIN_PIECE characters and appear in order without overlapping, so fragments cannot be stitched together.
 */
function quotedSpan(pieces: string[], text: string): [number, number] | null {
  if (!pieces.length) return null;
  if (pieces.length === 1) {
    const piece = pieces[0]!;
    if (piece === text) return [0, text.length];
    const at = piece.length >= MIN_QUOTE ? text.indexOf(piece) : -1;
    return at < 0 ? null : [at, at + piece.length];
  }
  if (pieces.some(p => p.length < MIN_PIECE)) return null;
  let start = -1, end = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, end);
    if (at < 0) return null;
    if (start < 0) start = at;
    end = at + piece.length;
  }
  return [start, end];
}

const short = (s: string, max = QUOTE_MAX) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/**
 * The human message `source` refers to, newest first: an exact id, a source that
 * contains an id, or a source whose quoted pieces are, in order, in one message's
 * human text (see quotedSpan). Null when none does.
 */
export function resolveHumanSource(source: string, candidates: HumanMessage[]): ResolvedSource | null {
  const newest = [...candidates].reverse();
  const quote = (m: HumanMessage) => short(humanText(m.text));
  const exact = newest.find(m => m.id === source.trim());
  if (exact) return { id: exact.id, quote: quote(exact) };
  const named = newest.find(m => m.id.length >= 8 && source.includes(m.id));
  if (named) return { id: named.id, quote: quote(named) };
  const pieces = piecesOf(fragments(source));
  for (const m of newest) {
    const own = humanText(m.text), map = normalized(own), span = quotedSpan(pieces, map.text);
    // The stored quote is the message's own words over the matched span, never the caller's passage.
    if (span) return { id: m.id, quote: short(own.slice(map.from[span[0]], map.to[span[1] - 1])) };
  }
  return null;
}

/** The newest candidates as `id — "preview"` lines, for a refusal that says what a source may be. */
export function sourceChoices(candidates: HumanMessage[], limit = 8): string {
  const rows = candidates.slice(-limit).reverse().map(m => `- ${m.id} (${m.at}): "${short(humanText(m.text), 80)}"`);
  return rows.length ? rows.join("\n") : "- (no human messages are retained for this project yet)";
}
