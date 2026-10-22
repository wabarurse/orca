// Explicit help content, separate from conversation history. Commands supply
// their own metadata so every handler stays discoverable without a second list.
import { wordWrap } from "./markdown";
import { bold, dim, visibleLength, wrap } from "./render";

export type HelpGroup = "conversation" | "projects" | "settings" | "advanced";
export interface HelpEntry { label: string; description: string }
export interface CommandHelp extends HelpEntry { group: HelpGroup; viewOnly?: true }

const NAVIGATION: HelpEntry[] = [
  { label: "Ctrl+N", description: "New orchestrator" },
  { label: "Ctrl+Z / Ctrl+X", description: "Previous / next project page" },
  { label: "Ctrl+B", description: "Open or close projects" },
  { label: "Ctrl+Q", description: "Open or close questions; arrivals never open them" },
  { label: "PgUp/PgDn / wheel", description: "Scroll conversation, help or task inbox" },
  { label: "Ctrl+C", description: "Cancel selected turn/agent; twice within 2s exits, keeping history" },
  { label: "Esc", description: "Close panel, else leave agent view, else clear input" },
];
const EDITING: HelpEntry[] = [
  { label: "Shift/Alt+Enter", description: "New line" },
  { label: "Alt+←/→ / Alt+B/F", description: "Move by word" },
  { label: "Alt+⌫ / Ctrl+W", description: "Delete previous word" },
  { label: "Alt+D", description: "Delete next word" },
  { label: "Home/End / Ctrl+A/E", description: "Start / end of current line" },
  { label: "Ctrl+U / Ctrl+K", description: "Delete to start / end of current line" },
  { label: "↑ / ↓", description: "Move between input rows, then project input history" },
];

/** Word-wrap descriptions, with wrap's single-cell fallback for impossibly narrow glyphs. */
const bounded = (text: string, width: number) => wordWrap(text, width).flatMap(row => wrap(row, width));

function groupRows(title: string, entries: HelpEntry[], cols: number, muted = false): string[] {
  const inset = cols >= 30 ? 2 : cols >= 12 ? 1 : 0;
  const pad = " ".repeat(inset);
  const width = Math.max(1, Math.min(96, cols) - inset * 2);
  const labelWidth = Math.max(...entries.map(entry => visibleLength(entry.label)));
  const aligned = width - labelWidth - 2 >= 24;
  const labelStyle = muted ? dim : bold;
  const rows = bounded(title, Math.max(1, cols - inset)).map(row => pad + (muted ? dim(row) : bold(row)));
  for (const entry of entries) {
    if (aligned) {
      const description = bounded(entry.description, width - labelWidth - 2);
      rows.push(...description.map((row, i) => pad + (i ? " ".repeat(labelWidth) : labelStyle(entry.label) + " ".repeat(labelWidth - visibleLength(entry.label))) + "  " + (muted ? dim(row) : row)));
    } else {
      rows.push(...bounded(entry.label, width).map(row => pad + labelStyle(row)));
      const indent = Math.min(2, width - 1);
      rows.push(...bounded(entry.description, width - indent).map(row => pad + " ".repeat(indent) + (muted ? dim(row) : row)));
    }
  }
  return rows;
}

/** Bounded, readable rows: aligned at comfortable widths, stacked on narrow terminals. */
export function helpLines(commands: ReadonlyMap<string, { help: CommandHelp }>, inView: boolean, cols = 80): string[] {
  cols = Math.max(1, cols);
  const entries = [...commands.values()].map(command => command.help).filter(entry => !entry.viewOnly || inView);
  const group = (id: HelpGroup, title: string) => groupRows(title, entries.filter(entry => entry.group === id), cols, id === "advanced");
  return [
    group("conversation", "Conversation"),
    group("projects", "Projects"),
    group("settings", "Model & accounts"),
    groupRows("Keyboard · navigation", NAVIGATION, cols),
    groupRows("Keyboard · editing", EDITING, cols),
    group("advanced", "Advanced & diagnostics"),
  ].flatMap((rows, i) => i ? ["", ...rows] : rows);
}
