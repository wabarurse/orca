// The daemon's live side channel: while a turn runs, what the agent streams
// (model text, tool starts and ends, plain status lines) is appended as small
// JSON events to `projects/<id>/orchestrator/live.jsonl`, so an attached TUI
// shows the turn as it did when the turn ran in-process. The transcript stays
// the durable record (written at message boundaries); the live file is
// presentation only: truncated at turn start, deleted at turn end once the
// turn's entries are durable, never read when its header names another run or
// turn than the live status. Every event carries the transcript head at the
// time it was emitted, so a client can tell which events a durable entry has
// since superseded (everything tagged with an older head) and which are still
// ahead of the record (those tagged with its current head).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { delay } from "../../tmux/cancellation";
import { paths } from "../../../config/config";
import type { ToolCall, ToolOutcome } from "../../../protocol/toolview";
import type { LiveEvent, LiveKey, TurnEvent } from "../../../protocol/daemon";

/** Bytes of live events per turn before text stops streaming (tools are still logged). */
export const LIVE_CAP_BYTES = 1 << 20;
/** How long `end` waits for pending appends before removing the file anyway. */
export const LIVE_END_WAIT_MS = 2000;

export const liveFile = (project: string): string => join(paths.orchestrator(project), "live.jsonl");

// --- the daemon's side ---------------------------------------------------------

export interface LiveWriterOptions {
  project: string;
  run: string;
  /** The transcript head as the daemon knows it (its own transcript). */
  head: () => string | null;
  /** Where the first failure is reported (the window); appends never throw into the turn. */
  log?: (text: string) => void;
  capBytes?: number;
}

export interface LiveWriter {
  /** A turn starts: the file is replaced by its `start` event. */
  begin(turn: number): void;
  /** The turn ended and its entries are durable: remove the file. Resolves once every append settled. */
  end(): Promise<void>;
  /** Streamed model text (`plain` for status lines, which are not markdown). */
  write(text: string, plain?: boolean): void;
  onTool(call: ToolCall): void;
  onToolResult(outcome: ToolOutcome): void;
}

/** Reports the first failure once; later ones are silent (the window is not a log). */
function firstFailure(log?: (text: string) => void): (error: unknown) => void {
  let failed = false;
  return error => {
    if (failed) return;
    failed = true;
    log?.(`orchestrator: live output stopped: ${error instanceof Error ? error.message : error}`);
  };
}

/**
 * Appends go one after another on a promise chain the turn never awaits, so a
 * slow or failing disk delays no turn; the first error is logged once. Text
 * past `capBytes` is replaced by a single `truncated` event; tool events are
 * still appended (the transcript bounds them). `end` waits at most
 * LIVE_END_WAIT_MS for the chain before removing the file regardless.
 */
export function liveWriter(o: LiveWriterOptions): LiveWriter {
  const path = liveFile(o.project), cap = o.capBytes ?? LIVE_CAP_BYTES;
  let chain = Promise.resolve(), seq = 0, bytes = 0, open = false, truncated = false;
  const fail = firstFailure(o.log);
  const queue = (op: () => Promise<void>) => { chain = chain.then(op).catch(fail); };
  const append = (event: object) => {
    const line = JSON.stringify(event) + "\n";
    bytes += Buffer.byteLength(line);
    queue(() => appendFile(path, line));
  };
  const tagged = (event: TurnEvent) => { if (open) append({ seq: ++seq, head: o.head(), ...event }); };
  const text = (kind: "text" | "status", text: string) => {
    if (!open || truncated) return;
    if (bytes + Buffer.byteLength(text) > cap) { truncated = true; tagged({ kind: "truncated" }); return; }
    tagged({ kind, text });
  };
  return {
    begin(turn) {
      seq = 0; bytes = 0; truncated = false; open = true;
      queue(() => writeFile(path, JSON.stringify({ seq: 0, kind: "start", run: o.run, turn, at: new Date().toISOString() } satisfies LiveEvent) + "\n"));
    },
    async end() {
      open = false;
      await Promise.race([chain, delay(LIVE_END_WAIT_MS)]);
      await rm(path, { force: true }).catch(fail); // a straggling append may recreate a headerless file: never read, replaced by the next begin
    },
    write: (t, plain) => text(plain ? "status" : "text", t),
    onTool: call => tagged({ kind: "tool_start", call }),
    onToolResult: outcome => tagged({ kind: "tool_end", outcome }),
  };
}

// --- the client's side ---------------------------------------------------------

export interface LiveReader {
  /** The complete events appended since the last read, in order; nothing while the file is absent or its header is not `expect`'s turn. */
  read(expect: LiveKey): LiveEvent[];
}

/** The file's first `headerLength` bytes and its bytes from `offset`; empty when it does not exist. */
function readFrom(path: string, offset: number, headerLength: number): { header: Buffer; data: Buffer; size: number } {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch { return { header: Buffer.alloc(0), data: Buffer.alloc(0), size: 0 }; }
  try {
    const size = fstatSync(fd).size;
    const slice = (from: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - from)));
      const n = buffer.length ? readSync(fd, buffer, 0, buffer.length, from) : 0;
      return buffer.subarray(0, n);
    };
    return { header: slice(0, headerLength), data: slice(offset, size - offset), size };
  } finally { closeSync(fd); }
}

function parseEvent(line: string): LiveEvent | undefined {
  try {
    const e = JSON.parse(line) as LiveEvent;
    return typeof e?.seq === "number" && typeof e.kind === "string" ? e : undefined;
  } catch { return; }
}

/** The complete lines of `rest` + `data` (bytes: a multibyte character split across reads is decoded whole), and what is left over. */
function completeLines(rest: Buffer, data: Buffer): { lines: string[]; rest: Buffer } {
  const all = Buffer.concat([rest, data]);
  const end = all.lastIndexOf(0x0a);
  if (end === -1) return { lines: [], rest: all };
  return { lines: all.subarray(0, end).toString("utf8").split("\n"), rest: Buffer.from(all.subarray(end + 1)) };
}

/** What a reader keeps between reads: where it is in the file, and whose file it is (its header line, the last seq seen). */
interface Cursor { offset: number; rest: Buffer; header?: { line: Buffer; key: LiveKey; seq: number; gapped: boolean } }
const fresh = (): Cursor => ({ offset: 0, rest: Buffer.alloc(0) });
const same = (a: LiveKey, b: LiveKey) => a.run === b.run && a.turn === b.turn;

/** The events after the last seq seen, in order: a re-read event is skipped, a gap is reported once per file. */
function inOrder(c: Cursor, events: LiveEvent[], log?: (text: string) => void): LiveEvent[] {
  const out: LiveEvent[] = [];
  const h = c.header!;
  for (const e of events) {
    if (e.seq <= h.seq) continue;
    if (e.seq > h.seq + 1 && !h.gapped) { h.gapped = true; log?.(`orchestrator: live output skipped ${e.seq - h.seq - 1} event(s)`); }
    h.seq = e.seq;
    out.push(e);
  }
  return out;
}

/**
 * Tail the live file: complete lines only (a line still being written waits),
 * and from the start again when the file was replaced (its header line is
 * re-read each time: a new turn has a new one; a file that shrank, too) or
 * names another turn than expected. Nothing is consumed until the first line
 * is the `start` of the expected run and turn: a late client, or a file a dead
 * daemon left behind, reads from the beginning once the current turn's header
 * is there.
 */
export function liveReader(project: string, log?: (text: string) => void): LiveReader {
  const path = liveFile(project);
  let c = fresh();
  return {
    read(expect) {
      if (c.header && !same(c.header.key, expect)) c = fresh();
      let got = readFrom(path, c.offset, c.header?.line.length ?? 0);
      if (replaced(c, got)) { c = fresh(); got = readFrom(path, 0, 0); }
      const split = completeLines(c.rest, got.data);
      const events = split.lines.flatMap(line => parseEvent(line) ?? []);
      if (!c.header && !accept(c, split.lines[0], events[0], expect)) return [];
      c.rest = split.rest;
      c.offset = got.size;
      return inOrder(c, events, log);
    },
  };
}

/** Whether the file under the cursor is no longer the one it was reading: it shrank, or its header line changed. */
const replaced = (c: Cursor, got: ReturnType<typeof readFrom>): boolean =>
  got.size < c.offset || (!!c.header && !got.header.equals(c.header.line));

/** Take the file as `expect`'s when its first line is that turn's `start`. */
function accept(c: Cursor, line: string | undefined, first: LiveEvent | undefined, expect: LiveKey): boolean {
  if (first?.kind !== "start" || !same(first, expect)) return false;
  c.header = { line: Buffer.from(`${line}\n`), key: { run: first.run, turn: first.turn }, seq: -1, gapped: false };
  return true;
}
