import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { errorCode, errorMessage, fail, ok, parseJson, paths, type Result } from "../config";
import type { AgentEvent, OpenSpan, Span, SpanDetail, SpanKind } from "./types";

export const SpanKindRecord: z.ZodType<SpanKind> = z.enum(["model", "tool", "wait-worker", "wait-inbox", "wait-process", "spawn", "compaction", "prep"]);
const openFields = { id: z.string(), kind: SpanKindRecord, label: z.string(), agent: z.string(), startedAt: z.string() };
export const OpenSpanRecord: z.ZodType<OpenSpan> = z.object(openFields);
export const SpanRecord: z.ZodType<Span> = z.object({ ...openFields, endedAt: z.string(), durationMs: z.number(), detail: z.record(z.string(), z.union([z.string(), z.number()])) });

export type SpanHandle = { span: OpenSpan; end: (detail: SpanDetail) => void };

export type Spans = {
  begin: (kind: SpanKind, label: string, startedAt: number | null, id: string | null) => SpanHandle;
  time: <T>(kind: SpanKind, label: string, run: () => Promise<T>, detail: (value: T) => SpanDetail) => Promise<T>;
};

let chain: Promise<void> = Promise.resolve();
const made = new Set<string>();

export const flushSpans = (): Promise<void> => chain;

function write(conversation: string, span: Span, failed: (error: unknown) => void): void {
  const file = paths.spans(conversation);
  const line = JSON.stringify(span) + "\n";
  chain = chain.then(async () => {
    const dir = dirname(file);
    if (!made.has(dir)) { await mkdir(dir, { recursive: true, mode: 0o700 }); made.add(dir); }
    await appendFile(file, line, { mode: 0o600 });
  }).catch(failed);
}

export function spanRecorder(conversation: string, agent: string, emit: (event: AgentEvent) => void): Spans {
  let warned = false;
  const failed = (error: unknown): void => {
    if (warned) return;
    warned = true;
    emit({ kind: "notice", text: `span recording unavailable (${errorMessage(error)}); execution continues` });
  };
  const begin = (kind: SpanKind, label: string, startedAt: number | null, id: string | null): SpanHandle => {
    const start = startedAt ?? Date.now();
    const span: OpenSpan = { id: id ?? crypto.randomUUID(), kind, label, agent, startedAt: new Date(start).toISOString() };
    emit({ kind: "span_start", span });
    let ended = false;
    return {
      span,
      end(detail) {
        if (ended) return;
        ended = true;
        const stop = Math.max(start, Date.now());
        const done: Span = { ...span, endedAt: new Date(stop).toISOString(), durationMs: stop - start, detail };
        emit({ kind: "span_end", span: done });
        write(conversation, done, failed);
      },
    };
  };
  return {
    begin,
    async time(kind, label, run, detail) {
      const handle = begin(kind, label, null, null);
      try {
        const value = await run();
        handle.end(detail(value));
        return value;
      } catch (error) {
        handle.end({ error: errorMessage(error).slice(0, 200) });
        throw error;
      }
    },
  };
}

export type PhaseTracker = { observe: (kind: SpanKind, label: string) => OpenSpan; close: () => void; current: () => OpenSpan | null };

export function phaseTracker(spans: Spans): PhaseTracker {
  let open: SpanHandle | null = null;
  return {
    observe(kind, label) {
      if (open !== null && open.span.kind === kind && open.span.label === label) return open.span;
      open?.end({});
      open = spans.begin(kind, label, null, null);
      return open.span;
    },
    close() { open?.end({}); open = null; },
    current: () => open?.span ?? null,
  };
}

export async function readSpans(conversation: string): Promise<Result<Span[]>> {
  let text: string;
  try { text = await readFile(paths.spans(conversation), "utf8"); }
  catch (error) { return errorCode(error) === "ENOENT" ? ok([]) : fail(errorMessage(error)); }
  const spans: Span[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const json = parseJson(line);
    const parsed = json.ok ? SpanRecord.safeParse(json.data) : null;
    if (parsed !== null && parsed.success) spans.push(parsed.data);
  }
  return ok(spans);
}

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

const VERB: Record<SpanKind, string> = {
  "model": "model", "tool": "running", "wait-worker": "waiting for", "wait-inbox": "waiting for", "wait-process": "waiting for",
  "spawn": "starting", "compaction": "compacting", "prep": "preparing",
};

export const phaseText = (span: OpenSpan, now: number): string => {
  const elapsed = clock(now - Date.parse(span.startedAt));
  return span.kind === "model" || span.kind === "prep" ? `thinking… (${elapsed})` : `${VERB[span.kind]} ${span.label} (${elapsed})`;
};

export function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
