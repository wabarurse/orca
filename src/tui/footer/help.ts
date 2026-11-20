// Explicit help content, separate from conversation history. Commands supply
// their own metadata so every handler stays discoverable without a second list.
import { wordWrap } from "../components";
import { bold, dim, visibleLength, wrap } from "../components";

export type HelpGroup = "conversation" | "projects" | "settings" | "advanced";
export interface HelpEntry { label: string; description: string }
export interface CommandHelp extends HelpEntry { group: HelpGroup; viewOnly?: true }

const NAVIGATION: HelpEntry[] = [
  { label: "ctrl+n", description: "new orchestrator" },
  { label: "ctrl+h / ctrl+l", description: "previous / next project page" },
  { label: "ctrl+a/t/q/g/p/b", description: "open Agents / Tasks / Questions / Images (gallery) / Processes / Bubbles; ctrl+t/g/p/b close it again" },
  { label: "letters and digits", description: "always type into the input; there is no Normal mode" },
  { label: "pgup/pgdn / wheel", description: "scroll conversation or help (mouse reporting required)" },
  { label: "click ▸", description: "open a run of tool calls (▾ when open); click again to fold it" },
  { label: "ctrl+c", description: "stop conversation and its agents; message to resume; twice within 2s exits" },
  { label: "ctrl+x", description: "show each key as the terminal sends it; the draft is kept; esc ends" },
  { label: "esc", description: "close panel or page, else leave agent view, else clear input" },
];
const PAGE: HelpEntry[] = [
  { label: "j/k ↑/↓ · gg/G", description: "move · first / last row" },
  { label: "ctrl+d / ctrl+u", description: "half a table page down / up; pgup/pgdn scroll the details" },
  { label: "h/l · 1–6 · tab/shift+tab", description: "previous / next tab · jump to a tab (←/→ fold on Tasks and open the Archived row)" },
  { label: "f or / · n/N", description: "find by name as you type (enter keeps, esc restores) · next / previous match" },
  { label: "a/A · u · r", description: "archive one / all (y confirms; the Archived row opens with enter) · restore · refresh" },
  { label: "enter", description: "agent: view transcript · question: choose or type an answer · image: desktop viewer · project: open" },
  { label: "answering", description: "j/k or a digit choose an option, Other… types one; enter sends; ctrl+d deletes the question; esc cancels" },
  { label: "s · t", description: "Agents: stop · Images: retry unconfirmed image prompts" },
  { label: "p · c · d · n", description: "Projects: pin · close the open page (project kept) · delete · new conversation (inside a project)" },
  { label: "esc / q", description: "close the page" },
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
    group("conversation", "conversation"),
    group("projects", "projects"),
    group("settings", "model & accounts"),
    groupRows("keyboard · navigation", NAVIGATION, cols),
    groupRows("keyboard · agents, tasks, questions, images, projects page", PAGE, cols),
    groupRows("keyboard · editing", EDITING, cols),
    group("advanced", "advanced & diagnostics"),
  ].flatMap((rows, i) => i ? ["", ...rows] : rows);
}
