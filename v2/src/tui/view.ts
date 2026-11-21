import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Fold } from "../core/plugins/types";
import { RESULT_MARK, TOOL_MARK, toolView, type ToolView } from "../core/toolview";
import type { AgentEvent, Entry, ToolCall, ToolOutcome } from "../core/types";
import { z } from "zod";
import { dim, editor, fit, pastel, railMark, renderMarkdown, sanitize, screens, shimmer, userFill, visibleLength, wordWrap } from "./components";

type Item = screens.ScreenItem;
type Call = { call: ToolCall; outcome: ToolOutcome | null };
type Piece = { kind: "text"; text: string } | { kind: "call"; call: Call } | { kind: "user"; text: string } | { kind: "from"; from: string; text: string } | { kind: "note"; text: string };

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

export function items(list: Piece[], state: ViewState): Item[] {
  const out: Item[] = [];
  const width = Math.max(10, state.cols - 2);
  let run: Call[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const key = `calls-${run[0]?.call.id ?? out.length}`;
    const plugin = state.folds.get(run[0]?.call.name ?? "");
    if (plugin !== undefined) {
      const rows = run.flatMap(c => c.outcome === null ? [] : plugin.items(inputRecord(c.call.input), { ok: c.outcome.ok, text: c.outcome.text }));
      if (rows.length > 0) out.push({ kind: "fold", key, gap: true, title: `+ ${plugin.title(rows.length)}`, failed: "", open: state.open.has(key), rows: rows.map(r => `● ${sanitize(r)}  open`), opens: plugin.opens });
      else out.push({ kind: "rows", key, gap: true, rows: run.flatMap(c => callRows(viewOf(c), width)) });
    } else if (run.length === 1 && run[0] !== undefined) out.push({ kind: "rows", key, gap: true, rows: callRows(viewOf(run[0]), width) });
    else {
      const views = run.map(viewOf);
      const failed = views.filter(v => v.failed).length;
      out.push({ kind: "fold", key, gap: true, title: `${run.length} tool calls · ${tally(views)}`, failed: failed > 0 ? ` · ${failed} failed` : "", open: state.open.has(key), rows: views.flatMap(v => callRows(v, width - 2)), opens: null });
    }
    run = [];
  };
  list.forEach((piece, index) => {
    if (piece.kind === "call") {
      const fold = state.folds.has(piece.call.call.name);
      if (run.length > 0 && (state.folds.has(run[0]?.call.name ?? "") || fold) && run[0]?.call.name !== piece.call.call.name) flush();
      run.push(piece.call);
      return;
    }
    flush();
    const key = `p-${index}`;
    if (piece.kind === "user") out.push({ kind: "user", key, gap: true, rows: wordWrap(sanitize(piece.text), Math.max(10, Math.floor(state.cols * 0.78) - 4)), fill: userFill() });
    else if (piece.kind === "text") out.push({ kind: "rows", key, gap: true, rows: renderMarkdown(piece.text, width) });
    else if (piece.kind === "from") out.push({ kind: "fold", key, gap: true, title: `from ${piece.from}`, failed: "", open: state.open.has(key), rows: renderMarkdown(piece.text, width - 2), opens: null });
    else out.push({ kind: "rows", key, gap: true, rows: [dim(fit(`· ${sanitize(piece.text)}`, width))] });
  });
  flush();
  return out;
}

export function tail(events: AgentEvent[], lastDurableText: string, cols: number, now: number, busy: boolean): string[] {
  let text = "";
  const running = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.kind === "text") text += event.text;
    if (event.kind === "tool_start") { running.set(event.call.id, event.call); text = ""; }
    if (event.kind === "tool_end") running.delete(event.call.id);
  }
  const width = Math.max(10, cols - 2);
  const shown = text.trim().length > 0 && text.trim() !== lastDurableText.trim() ? renderMarkdown(text, width) : [];
  const calls = [...running.values()].map(call => shimmer(fit(`${TOOL_MARK} ${toolView(call.name, call.input, { ok: true, text: "" }).tool}`, width), now));
  const activity = busy && calls.length === 0 && shown.length === 0 ? [dim(shimmer("thinking…", now))] : [];
  return [...shown, ...calls, ...activity];
}

export type Composer = { prompt: string; state: editor.EditState };

export function composerRows(c: Composer, counts: string, cols: number, maxRows: number): { rows: string[]; row: number; col: number } {
  const inner = Math.max(4, cols - 4);
  const prompt = fit(sanitize(c.prompt), Math.max(0, inner - 4));
  const indent = visibleLength(prompt);
  const lay = editor.layout(c.state, Math.max(1, inner - indent));
  const shown = Math.max(1, Math.min(lay.rows.length, maxRows));
  const top = editor.scrollWindow(lay.rows.length, lay.row, lay.rows.length, shown);
  const body = lay.rows.slice(top, top + shown).map((r, i) => {
    const text = fit((top + i === 0 ? prompt : " ".repeat(indent)) + sanitize(r.text), inner);
    return `${railMark("│")} ${text}${" ".repeat(Math.max(0, inner - visibleLength(text)))} ${railMark("│")}`;
  });
  const status = counts.length > 0 ? fit(counts, inner) : "";
  const bottom = status.length > 0 ? `${railMark("│")} ${dim(status)}${" ".repeat(Math.max(0, inner - visibleLength(status)))} ${railMark("│")}` : railMark(`└${"─".repeat(cols - 2)}┘`);
  return { rows: [railMark(`┌${"─".repeat(cols - 2)}┐`), ...body, bottom], row: 1 + lay.row - top, col: 2 + indent + lay.col };
}
