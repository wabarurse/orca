// Structural comparison of append-only transcripts by a line ledger.
//
// A transcript's head is the LAST LINE in file order, so two histories are never union-merged. Each file
// becomes [(uuid, sha256(canonical line))] in file order; two ledgers are related only by prefix: equal, one
// a strict prefix of the other (fast-forward / destination newer), or neither (DIVERGED, refused).
// Timestamps are information, never a tie-break.
//
// Canonical form: the image-ref scope tokens that belong to the project are replaced by SCOPE_PLACEHOLDER
// before hashing, so a fork (which gets a new sessionId and so a new scope) still compares equal to its source.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { open, paired } from "../data/transcripts";
import { SCOPE_PLACEHOLDER, sha256 } from "./bundle";

export interface LedgerEntry { uuid: string; sha: string }
export interface Ledger { entries: LedgerEntry[]; lastTs?: string }
/** The entry types protocol/transcript.ts defines. A test keeps this in step with it. */
export const KNOWN_TYPES = new Set(["message", "summary", "meta", "replies", "context-boundary", "model-request", "tool-recovery"]);

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
export const replaceScopes = (text: string, scopes: string[], to: string) => scopes.reduce((t, s) => (s ? t.replaceAll(s, to) : t), text);
export const canonicalLine = (line: string, scopes: string[]) => replaceScopes(line, scopes, SCOPE_PLACEHOLDER);

type Parsed = { uuid?: unknown; type?: unknown; ts?: unknown };
function parseLine(line: string): Parsed | undefined {
  try { return JSON.parse(line) as Parsed; }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; } // damaged bytes are carried, never replayed
}

/** Throws on an unknown entry type: a newer orca wrote it and this one cannot promise to carry it faithfully. */
export function ledgerOf(text: string, scopes: string[], what = "transcript"): Ledger {
  const entries: LedgerEntry[] = [];
  let lastTs: string | undefined;
  for (const [i, line] of splitLines(text).entries()) {
    const entry = parseLine(line);
    const known = typeof entry?.uuid === "string" && typeof entry.type === "string";
    if (known && !KNOWN_TYPES.has(entry.type as string)) throw new Error(`${what} line ${i + 1}: unknown entry type ${JSON.stringify(entry!.type)} (written by a newer orca?)`);
    if (known && typeof entry!.ts === "string") lastTs = entry!.ts;
    entries.push({ uuid: known ? (entry!.uuid as string) : "", sha: sha256(canonicalLine(line, scopes)) });
  }
  return { entries, lastTs };
}

export const ledgerDigest = (ledger: Ledger) => sha256(ledger.entries.map(e => `${e.uuid}:${e.sha}\n`).join(""));

export type RelationKind = "equal" | "fast-forward" | "destination-newer" | "diverged";
export interface Relation { kind: RelationKind; common: number; onlySource: number; onlyDestination: number; sourceLastTs?: string; destinationLastTs?: string }

/** `source` is the incoming side, `destination` the local one. */
export function relate(source: Ledger, destination: Ledger): Relation {
  const a = source.entries, b = destination.entries;
  let common = 0;
  while (common < a.length && common < b.length && a[common]!.uuid === b[common]!.uuid && a[common]!.sha === b[common]!.sha) common++;
  const onlySource = a.length - common, onlyDestination = b.length - common;
  const kind: RelationKind = onlySource && onlyDestination ? "diverged" : onlySource ? "fast-forward" : onlyDestination ? "destination-newer" : "equal";
  return { kind, common, onlySource, onlyDestination, sourceLastTs: source.lastTs, destinationLastTs: destination.lastTs };
}

export function describeDivergence(id: string, r: Relation): string {
  return `${id}: DIVERGED after ${r.common} common entries; ${r.onlySource} only on the sending side (last ts ${r.sourceLastTs ?? "n/a"}), ` +
    `${r.onlyDestination} only on the receiving side (last ts ${r.destinationLastTs ?? "n/a"}); timestamps are information only`;
}

/** sha256 of the exact JSON of chain() plus the pairing check, computed through the real Transcript reader. */
export async function chainOf(text: string, normalise?: { from: string; to: string }): Promise<{ digest: string; messages: number; bytes: number; paired: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-chain-"));
  try {
    const path = join(dir, "t", "x.jsonl");
    await mkdir(join(dir, "t"));
    await writeFile(path, text);
    const chain: MessageParam[] = await open(path).chain();
    const exact = JSON.stringify(chain);
    // A fork re-scopes image refs; its digest is compared with the exporter's after mapping the scope back.
    return { digest: sha256(normalise ? exact.replaceAll(normalise.from, normalise.to) : exact), messages: chain.length, bytes: exact.length, paired: paired(chain) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export interface ImageRefSeen { scope: string; id: string; sha256: string }
const URL_REF = /(?:orca-image|parallels-image):([a-f0-9]{64}):([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):([a-f0-9]{64})/g;
const isRefObject = (v: unknown): v is ImageRefSeen => {
  const r = v as Record<string, unknown>;
  return typeof r.scope === "string" && /^[a-f0-9]{64}$/.test(r.scope) && typeof r.id === "string" && typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256);
};
function walk(value: unknown, out: ImageRefSeen[]): void {
  if (Array.isArray(value)) { for (const v of value) walk(v, out); return; }
  if (!value || typeof value !== "object") return;
  if (isRefObject(value)) out.push({ scope: value.scope, id: value.id, sha256: value.sha256 });
  for (const v of Object.values(value)) walk(v, out);
}
/** Image references in transcript lines and image-input journals, in both encodings: `orca-image:<scope>:<id>:<sha>` URLs
 * inside content blocks and `{id, scope, sha256}` objects in attachments. */
export function imageRefs(text: string): ImageRefSeen[] {
  const out = [...text.matchAll(URL_REF)].map(m => ({ scope: m[1]!, id: m[2]!, sha256: m[3]! }));
  for (const line of splitLines(text)) { const parsed = parseLine(line); if (parsed) walk(parsed, out); }
  return out;
}
