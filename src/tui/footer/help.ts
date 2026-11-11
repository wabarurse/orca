// Explicit help content, separate from conversation history. Commands supply
// their own metadata so every handler stays discoverable without a second list.
import { wordWrap } from "../components";
import { bold, dim, visibleLength, wrap } from "../components";

export type HelpGroup = "conversation" | "projects" | "settings" | "advanced";
export interface HelpEntry { label: string; description: string }
export interface CommandHelp extends HelpEntry { group: HelpGroup; viewOnly?: true }

const NAVIGATION: HelpEntry[] = [
  { label: "ctrl+n", description: "new orchestrator" },
  { label: "ctrl+z / ctrl+x", description: "previous / next project page" },
  { label: "ctrl+b", description: "open or close projects" },
  { label: "ctrl+t", description: "task list; up/down selects; left folds/parent; right expands or focuses details; details up/down scrolls, left returns; terminal gesture opens PR links; r refresh; ctrl+t/esc returns to draft" },
  { label: "ctrl+a", description: "open the Agents page" },
  { label: "ctrl+q", description: "open the Questions list; arrivals update its count" },
  { label: "ctrl+d (question)", description: "delete shown question; no reply" },
  { label: "pgup/pgdn / wheel", description: "scroll conversation, help or lists (mouse reporting required)" },
  { label: "click ▸", description: "open a run of tool calls (▾ when open); click again to fold it" },
  { label: "ctrl+c", description: "stop conversation and its agents; message to resume; twice within 2s exits" },
  { label: "esc", description: "close panel, else leave agent view, else clear input" },
];
const EDITING: HelpEntry[] = [
  { label: "drag / ctrl+o / esc", description: "highlight + auto-copy on release / re-copy / clear highlight" },
  { label: "ctrl+v / ctrl+y", description: "attach clipboard image / remove last image. terminal text paste is unchanged" },
  { label: "shift/alt+enter", description: "new line" },
  { label: "alt+←/→ / alt+b/f", description: "move by word" },
  { label: "alt+⌫ / ctrl+w", description: "delete previous word" },
  { label: "alt+d", description: "delete next word" },
  { label: "home/end / ctrl+e", description: "start / end of current line" },
  { label: "ctrl+u / ctrl+k", description: "delete to start / end of current line" },
  { label: "↑ / ↓", description: "move between input rows, then project input history" },
];

const VIM: HelpEntry[] = [
  { label: "i / Esc", description: "enter Insert / return to Normal while preserving the draft" },
  { label: "Shift+H / Shift+L", description: "previous / next project tab (gT / gt also work)" },
  { label: "q", description: "back from pages and menus; Insert mode still types q" },
  { label: "Shift+A/T/Q/P", description: "Agents / Tasks / Questions / Images" },
  { label: "Shift+U/M/E/F", description: "Accounts / Models / Effort / Fast" },
  { label: "Shift+B/R/S · ?", description: "Projects / Refresh / Stop · Help (Shift+/)" },
  { label: "Shift+V/X", description: "attach clipboard image / remove last draft image" },
  { label: "j/k · gg/G", description: "move down/up or jump to the first/last row" },
  { label: "h/l", description: "focus list/details in work views" },
  { label: ":", description: "type any slash command and arguments; Tab completes a unique command" },
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
export function helpLines(commands: ReadonlyMap<string, { help: CommandHelp }>, inView: boolean, cols = 80, vim = false): string[] {
  cols = Math.max(1, cols);
  const entries = [...commands.values()].map(command => command.help).filter(entry => !entry.viewOnly || inView);
  const group = (id: HelpGroup, title: string) => groupRows(title, entries.filter(entry => entry.group === id), cols, id === "advanced");
  return [
    group("conversation", "conversation"),
    group("projects", "projects"),
    group("settings", "model & accounts"),
    groupRows("keyboard · navigation", vim ? VIM : NAVIGATION, cols),
    ...(vim ? [] : [groupRows("keyboard · editing", EDITING, cols)]),
    group("advanced", "advanced & diagnostics"),
  ].flatMap((rows, i) => i ? ["", ...rows] : rows);
}
