import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Fold } from "../core/plugins/types";
import { RESULT_MARK, TOOL_MARK, toolView, type ToolView } from "../core/toolview";
import { clock, phaseText } from "../core/spans";
import type { AgentEvent, Entry, OpenSpan, ToolCall, ToolOutcome } from "../core/types";
import { z } from "zod";
import { dim, expandTabs, fit, pastel, railMark, renderMarkdown, sanitize, screens, shimmer, swimming, userFill, visibleLength, wordWrap, type TextInput } from "./components";

type Item = screens.ScreenItem;
type Call = { call: ToolCall; outcome: ToolOutcome | null };
export type Piece = { kind: "text"; text: string } | { kind: "call"; call: Call } | { kind: "user"; text: string } | { kind: "from"; from: string; text: string } | { kind: "note"; text: string };

const InputRecord = z.record(z.string(), z.unknown());
const inputRecord = (input: unknown): Record<string, unknown> => { const parsed = InputRecord.safeParse(input); return parsed.success ? parsed.data : {}; };

const REFERENCE = /^\[orca reference: /;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[${pastel.red}m${s}\x1b[0m`;

const blockText = (content: MessageParam["content"]): string => typeof content === "string" ? content
  : content.map(block => block.type === "text" ? block.text : "").filter(text => text.length > 0).join("\n");

export function pieces(entries: Entry[]): Piece[] {
  const out: Piece[] = [];
  const calls = new Map<string, Call>();
  for (const entry of entries) {
    if (entry.type === "summary") { out.push({ kind: "note", text: "older conversation summarized (rolling memory)" }); continue; }
    if (entry.type === "replies") { for (const m of entry.messages) out.push({ kind: "from", from: m.from, text: m.text }); continue; }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      if (typeof message.content === "string") { out.push({ kind: "text", text: message.content }); continue; }
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim().length > 0) out.push({ kind: "text", text: block.text });
        if (block.type === "tool_use") { const call = { call: { id: block.id, name: block.name, input: block.input }, outcome: null }; calls.set(block.id, call); out.push({ kind: "call", call }); }
      }
      continue;
    }
    if (typeof message.content !== "string") for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (call !== undefined) call.outcome = { id: block.tool_use_id, ok: block.is_error !== true, text: typeof block.content === "string" ? block.content : (block.content ?? []).map(b => b.type === "text" ? b.text : "[image]").join("\n") };
    }
    for (const m of entry.inbox) {
      if (m.from === "user") out.push({ kind: "user", text: m.text + m.images.map(id => ` [image ${id}]`).join("") });
      else out.push({ kind: "from", from: m.from, text: m.text });
    }
    if (entry.inbox.length === 0 && typeof message.content === "string" && !REFERENCE.test(message.content) && !message.content.startsWith("Continue the existing request")) {
      const text = blockText(message.content);
      if (text.length > 0 && entry.inbox.length === 0) out.push({ kind: "note", text: text.slice(0, 200) });
    }
  }
  return out;
}

const viewOf = (c: Call): ToolView => c.outcome === null ? { ...toolView(c.call.name, c.call.input, { ok: false, text: "" }), summary: "running", failed: false } : toolView(c.call.name, c.call.input, c.outcome);

export function callRows(v: ToolView, cols: number): string[] {
  return [fit(`${v.failed ? red(TOOL_MARK) : TOOL_MARK} ${bold(sanitize(v.tool))}`, cols), dim(fit(`${RESULT_MARK}${sanitize(v.summary)}`, cols))];
}

export function tally(views: ToolView[]): string {
  const counts = new Map<string, number>();
  for (const v of views) { const name = v.tool.split("(")[0] ?? v.tool; counts.set(name, (counts.get(name) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`).join(", ");
}

export type ViewState = { cols: number; open: Set<string>; folds: Map<string, Fold> };

export const TOOLS_MARK = "⚒";
export const FROM_MARK = "✉";

export const CORE_FOLDS: ReadonlyMap<string, Fold> = new Map<string, Fold>([["subagent", {
  title: n => `${n} agent${n === 1 ? "" : "s"}`,
  items: (input, outcome) => input.action === "spawn" && outcome.ok ? [outcome.text.split(" ")[0] ?? ""].filter(agent => agent.length > 0) : [],
  opens: "agents",
}]]);

export const USER_ROWS = 10;

export function userItem(text: string, key: string, state: { cols: number; open: Set<string> }): Item {
  const width = Math.max(10, Math.floor(state.cols * 0.78) - 4);
  const rows = text.split(/\r\n?|\n/).flatMap(line => { const wrapped = wordWrap(sanitize(expandTabs(line)), width); return wrapped.length > 0 ? wrapped : [""]; });
  const more = Math.max(0, rows.length - USER_ROWS);
  const open = more > 0 && state.open.has(key);
  return { kind: "user", key, gap: true, rows: more > 0 && !open ? rows.slice(0, USER_ROWS) : rows, fill: userFill(), open, more };
}

export function items(list: Piece[], state: ViewState): Item[] {
  const out: Item[] = [];
  const width = Math.max(10, state.cols - 2);
  let run: Call[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const key = `calls-${run[0]?.call.id ?? out.length}`;
    const views = run.map(viewOf);
    const failed = views.filter(v => v.failed).length;
    out.push({ kind: "fold", key, gap: true, title: `${TOOLS_MARK} ${run.length} tool call${run.length === 1 ? "" : "s"} · ${tally(views)}`, failed: failed > 0 ? ` · ${failed} failed` : "", open: state.open.has(key), rows: views.flatMap(v => callRows(v, width - 2)), opens: null });
    const groups = new Map<string, { fold: Fold; rows: string[] }>();
    for (const c of run) {
      const fold = state.folds.get(c.call.name);
      if (fold === undefined || c.outcome === null) continue;
      const found = fold.items(inputRecord(c.call.input), { ok: c.outcome.ok, text: c.outcome.text });
      if (found.length === 0) continue;
      const group = groups.get(c.call.name) ?? { fold, rows: [] };
      group.rows.push(...found);
      groups.set(c.call.name, group);
    }
    for (const [tool, group] of groups) {
      const groupKey = `${key}-${tool}`;
      out.push({ kind: "fold", key: groupKey, gap: false, title: `+ ${group.fold.title(group.rows.length)}`, failed: "", open: state.open.has(groupKey), rows: group.rows.map(r => `● ${sanitize(r)}  open`), opens: group.fold.opens });
    }
    run = [];
  };
  list.forEach((piece, index) => {
    if (piece.kind === "call") { run.push(piece.call); return; }
    flush();
    const key = `p-${index}`;
    if (piece.kind === "user") out.push(userItem(piece.text, key, state));
    else if (piece.kind === "text") out.push({ kind: "rows", key, gap: true, rows: renderMarkdown(piece.text, width) });
    else if (piece.kind === "from") out.push({ kind: "fold", key, gap: true, title: `${FROM_MARK} from agent ${piece.from}`, failed: "", open: state.open.has(key), rows: renderMarkdown(piece.text, width - 2), opens: null });
    else out.push({ kind: "rows", key, gap: true, rows: [dim(fit(`· ${sanitize(piece.text)}`, width))] });
  });
  flush();
  return out;
}

export function tail(events: AgentEvent[], lastDurableText: string, cols: number, now: number, busy: boolean, waiting: OpenSpan | null): string[] {
  let text = "";
  const running = new Map<string, ToolCall>();
  const open = new Map<string, OpenSpan>();
  for (const event of events) {
    if (event.kind === "text") text += event.text;
    if (event.kind === "tool_start") { running.set(event.call.id, event.call); text = ""; }
    if (event.kind === "tool_end") running.delete(event.call.id);
    if (event.kind === "span_start") open.set(event.span.id, event.span);
    if (event.kind === "span_end") open.delete(event.span.id);
  }
  const width = Math.max(10, cols - 2);
  const shown = text.trim().length > 0 && text.trim() !== lastDurableText.trim() ? renderMarkdown(text, width) : [];
  const calls = [...running.values()].map(call => {
    const span = open.get(call.id);
    const elapsed = span === undefined ? "" : ` (${clock(now - Date.parse(span.startedAt))})`;
    return shimmer(fit(`${TOOL_MARK} ${toolView(call.name, call.input, { ok: true, text: "" }).tool}${elapsed}`, width), now);
  });
  if (!busy) return waiting !== null && waiting.kind !== "wait-inbox" ? [...shown, dim(fit(phaseText(waiting, now), width))] : shown;
  const phase = [...open.values()].filter(span => span.kind !== "tool").at(-1) ?? null;
  const thinking = phase !== null && (phase.kind === "model" || phase.kind === "prep");
  const activity = thinking ? [fit(swimming(clock(now - Date.parse(phase.startedAt)), now), width)]
    : phase !== null ? [dim(shimmer(fit(phaseText(phase, now), width), now))]
    : calls.length === 0 && shown.length === 0 ? [fit(swimming(null, now), width)] : [];
  return [...shown, ...calls, ...activity];
}

export type Composer = { prompt: string; input: TextInput };
export type ComposerBox = { rows: string[]; row: number; col: number; cursor: boolean; bodyTop: number; bodyLeft: number; bodyRows: number };

const composerPrompt = (prompt: string, cols: number): string => fit(sanitize(prompt), Math.max(0, Math.max(4, cols - 4) - 4));

export function composerWidth(prompt: string, cols: number): number {
  return Math.max(1, Math.max(4, cols - 4) - visibleLength(composerPrompt(prompt, cols)));
}

export function composerRows(c: Composer, counts: string, right: string, cols: number, maxRows: number): ComposerBox {
  const inner = Math.max(4, cols - 4);
  const prompt = composerPrompt(c.prompt, cols);
  const indent = visibleLength(prompt);
  const lay = c.input.render(composerWidth(c.prompt, cols), maxRows);
  const body = lay.rows.map((r, i) => {
    const text = fit((i === 0 ? prompt : " ".repeat(indent)) + r, inner);
    return `${railMark("│")} ${text}${" ".repeat(Math.max(0, inner - visibleLength(text)))} ${railMark("│")}`;
  });
  const tail = right.length > 0 && visibleLength(counts) + right.length + 3 <= inner ? right : "";
  const status = counts.length > 0 || tail.length > 0 ? fit(counts, inner - (tail.length > 0 ? tail.length + 3 : 0)) : "";
  const gap = " ".repeat(Math.max(0, inner - visibleLength(status) - tail.length));
  const bottom = status.length > 0 || tail.length > 0 ? `${railMark("│")} ${dim(`${status}${gap}${tail}`)} ${railMark("│")}` : railMark(`└${"─".repeat(cols - 2)}┘`);
  return { rows: [railMark(`┌${"─".repeat(cols - 2)}┐`), ...body, bottom], row: 1 + lay.row, col: 2 + indent + lay.col, cursor: lay.cursor, bodyTop: 1, bodyLeft: 2 + indent, bodyRows: body.length };
}
