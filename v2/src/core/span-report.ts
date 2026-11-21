import type { Span, SpanKind } from "./types";

export type Bucket = SpanKind | "unaccounted";
export type Totals = Record<Bucket, number>;
export type AgentBreakdown = { agent: string; wallMs: number; spans: number; kinds: Totals };
export type SpanReport = {
  conversation: string;
  startedAt: string | null;
  endedAt: string | null;
  wallMs: number;
  activeMs: number;
  modelMs: number;
  nonModelMs: number;
  kinds: Totals;
  agents: AgentBreakdown[];
  longest: Span[];
};

const ORDER: SpanKind[] = ["model", "tool", "spawn", "prep", "compaction", "wait-process", "wait-worker", "wait-inbox"];
const BUCKETS: Bucket[] = [...ORDER, "unaccounted"];

const zero = (): Totals => ({ "model": 0, "tool": 0, "spawn": 0, "prep": 0, "compaction": 0, "wait-process": 0, "wait-worker": 0, "wait-inbox": 0, "unaccounted": 0 });

type Interval = { start: number; end: number; kind: SpanKind; order: number };
type Segment = { start: number; end: number; kind: Bucket };

function intervals(spans: Span[]): Interval[] {
  return spans.flatMap((span, order) => {
    const start = Date.parse(span.startedAt), end = Date.parse(span.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end, kind: span.kind, order }] : [];
  });
}

function boundaries(list: { start: number; end: number }[]): number[] {
  return [...new Set(list.flatMap(item => [item.start, item.end]))].sort((a, b) => a - b);
}

function agentSegments(list: Interval[]): Segment[] {
  const times = boundaries(list);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i], end = times[i + 1];
    if (start === undefined || end === undefined) continue;
    let inner: Interval | null = null;
    for (const item of list) {
      if (item.start > start || item.end < end) continue;
      if (inner === null || item.start > inner.start || (item.start === inner.start && item.order > inner.order)) inner = item;
    }
    out.push({ start, end, kind: inner === null ? "unaccounted" : inner.kind });
  }
  return out;
}

function combine(perAgent: Segment[][]): Segment[] {
  const all = perAgent.flat().filter(segment => segment.kind !== "unaccounted");
  const times = boundaries(all);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i], end = times[i + 1];
    if (start === undefined || end === undefined) continue;
    let best: Bucket = "unaccounted";
    for (const segment of all) {
      if (segment.start > start || segment.end < end || segment.kind === "unaccounted") continue;
      if (best === "unaccounted" || ORDER.indexOf(segment.kind) < ORDER.indexOf(best)) best = segment.kind;
    }
    out.push({ start, end, kind: best });
  }
  return out;
}

function sum(segments: Segment[]): Totals {
  const totals = zero();
  for (const segment of segments) totals[segment.kind] += segment.end - segment.start;
  return totals;
}

export function spanReport(conversation: string, spans: Span[]): SpanReport {
  const all = intervals(spans);
  const names = [...new Set(spans.map(span => span.agent))];
  const perAgent = names.map(agent => ({ agent, segments: agentSegments(all.filter(item => spans[item.order]?.agent === agent)), count: spans.filter(span => span.agent === agent).length }));
  const timeline = combine(perAgent.map(entry => entry.segments));
  const kinds = sum(timeline);
  const first = all.length === 0 ? null : Math.min(...all.map(item => item.start));
  const last = all.length === 0 ? null : Math.max(...all.map(item => item.end));
  const wallMs = first === null || last === null ? 0 : last - first;
  const activeMs = wallMs - kinds["wait-inbox"];
  const agents = perAgent.map(entry => {
    const starts = entry.segments.map(s => s.start), ends = entry.segments.map(s => s.end);
    return { agent: entry.agent, spans: entry.count, wallMs: starts.length === 0 ? 0 : Math.max(...ends) - Math.min(...starts), kinds: sum(entry.segments) };
  }).sort((a, b) => b.wallMs - a.wallMs);
  const longest = [...spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  return { conversation, startedAt: first === null ? null : new Date(first).toISOString(), endedAt: last === null ? null : new Date(last).toISOString(),
    wallMs, activeMs, modelMs: kinds.model, nonModelMs: activeMs - kinds.model, kinds, agents, longest };
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

const percent = (part: number, whole: number): string => whole > 0 ? `${Math.round(part / whole * 100)}%` : "0%";

export function formatReport(report: SpanReport): string {
  if (report.wallMs === 0) return `conversation ${report.conversation}: no spans recorded\n`;
  const lines = [
    `conversation ${report.conversation} · wall ${duration(report.wallMs)} · active ${duration(report.activeMs)} · idle for input ${duration(report.kinds["wait-inbox"])}`,
    `model ${duration(report.modelMs)} (${percent(report.modelMs, report.activeMs)} of active) · non-model ${duration(report.nonModelMs)} (${percent(report.nonModelMs, report.activeMs)})`,
    "",
    "where the non-model time went:",
  ];
  const rest = BUCKETS.filter(kind => kind !== "model" && kind !== "wait-inbox" && report.kinds[kind] > 0).sort((a, b) => report.kinds[b] - report.kinds[a]);
  for (const kind of rest) lines.push(`  ${kind.padEnd(13)} ${duration(report.kinds[kind]).padStart(7)}  ${percent(report.kinds[kind], report.activeMs).padStart(4)}`);
  if (rest.length === 0) lines.push("  (none)");
  lines.push("", "by agent (each agent's own time; waits overlap other agents' work):");
  for (const agent of report.agents) {
    const parts = BUCKETS.filter(kind => agent.kinds[kind] > 0).map(kind => `${kind} ${duration(agent.kinds[kind])}`);
    lines.push(`  ${agent.agent.padEnd(20)} wall ${duration(agent.wallMs).padStart(7)} · ${agent.spans} spans · ${parts.join(" · ")}`);
  }
  lines.push("", "longest spans:");
  report.longest.forEach((span, index) => {
    lines.push(`  ${String(index + 1).padStart(2)}. ${duration(span.durationMs).padStart(7)}  ${span.kind.padEnd(12)} ${span.agent.padEnd(20)} ${span.label}`);
  });
  return lines.join("\n") + "\n";
}
