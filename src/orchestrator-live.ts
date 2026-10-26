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
import { paths } from "./config";
import type { ToolCall, ToolOutcome } from "./toolview";

/** Bytes of live events per turn before text stops streaming (tools are still logged). */
export const LIVE_CAP_BYTES = 1 << 20;

/** What happened during the turn, after the transcript entry `head` (the daemon's head when it happened). */
export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "status"; text: string }
  | { kind: "tool_start"; call: ToolCall }
  | { kind: "tool_end"; outcome: ToolOutcome }
  | { kind: "truncated" };
export type LiveEvent =
  | { seq: 0; kind: "start"; run: string; turn: number; at: string }
  | (TurnEvent & { seq: number; head: string | null });
/** Which turn a live file belongs to: the daemon's run and its status.json turn counter. */
export interface LiveKey { run: string; turn: number }

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
 * Appends go one after another on a promise chain, never awaited by the turn,
 * so a slow or failing disk delays nothing and the first error is logged once.
 * Text past `capBytes` is replaced by a single `truncated` event; tool events
 * are still appended (the transcript bounds them).
 */
export function liveWriter(o: LiveWriterOptions): LiveWriter {
  const path = liveFile(o.project), cap = o.capBytes ?? LIVE_CAP_BYTES;
  let chain = Promise.resolve(), seq = 0, bytes = 0, open = false, truncated = false;
  const fail = firstFailure(o.log);
  const queue = (op: () => Promise<void>) => { chain = chain.then(op).catch(fail); };
  const append = (event: object) => {
    const line = JSON.stringify(event) + "\n";
    bytes += line.length;
    queue(() => appendFile(path, line));
  };
  const tagged = (event: TurnEvent) => { if (open) append({ seq: ++seq, head: o.head(), ...event }); };
  const text = (kind: "text" | "status", text: string) => {
    if (!open || truncated) return;
    if (bytes + text.length > cap) { truncated = true; tagged({ kind: "truncated" }); return; }
    tagged({ kind, text });
  };
  return {
    begin(turn) {
      seq = 0; bytes = 0; truncated = false; open = true;
      queue(() => writeFile(path, JSON.stringify({ seq: 0, kind: "start", run: o.run, turn, at: new Date().toISOString() } satisfies LiveEvent) + "\n"));
    },
    async end() {
      open = false;
      queue(() => rm(path, { force: true }));
      await chain;
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

/** The file's bytes from `offset`; empty when it does not exist. */
function readFrom(path: string, offset: number): { data: string; size: number } {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch { return { data: "", size: 0 }; }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { data: "", size };
    const buffer = Buffer.alloc(size - offset);
    const n = readSync(fd, buffer, 0, buffer.length, offset);
    return { data: buffer.subarray(0, n).toString("utf8"), size };
  } finally { closeSync(fd); }
}

function parseEvent(line: string): LiveEvent | undefined {
  try {
    const e = JSON.parse(line) as LiveEvent;
    return typeof e?.seq === "number" && typeof e.kind === "string" ? e : undefined;
  } catch { return; }
}

/**
 * Tail the live file: complete lines only (a line still being written waits),
 * and from the start again when the file shrank or names another turn (a new
 * turn replaced it). Nothing is consumed until the first line is the `start`
 * of the expected run and turn: a late client, or a file a dead daemon left
 * behind, reads from the beginning once the current turn's header is there.
 */
export function liveReader(project: string): LiveReader {
  const path = liveFile(project);
  let offset = 0, rest = "", key: LiveKey | undefined;
  const same = (a: LiveKey, b: LiveKey) => a.run === b.run && a.turn === b.turn;
  const reset = () => { offset = 0; rest = ""; key = undefined; };
  return {
    read(expect) {
      if (key && !same(key, expect)) reset();
      let got = readFrom(path, offset);
      if (got.size < offset) { reset(); got = readFrom(path, 0); }
      const lines = (rest + got.data).split("\n");
      const tail = lines.pop()!;
      const events = lines.flatMap(line => parseEvent(line) ?? []);
      if (!key) {
        const first = events[0];
        if (first?.kind !== "start" || !same(first, expect)) return [];
        key = { run: first.run, turn: first.turn };
      }
      rest = tail;
      offset = got.size;
      return events;
    },
  };
}
