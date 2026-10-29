// The /agents list: which agents it shows by default, the "+N older hidden" line,
// `a` to show them all, and `d` / `D` (with y/n) to remove finished agents' rows.
// Removing only records a marker in project state (core/tmux archiveAgents); the
// transcript, run file and history stay, and a started-again agent shows again.

import type { AgentInfo } from "../../protocol";

/** A finished agent stays in the default view this long after its latest activity. */
export const RECENT_AGENT_MS = 24 * 60 * 60 * 1000;
export const AGENTS_HINT = "↑↓ enter attaches   a shows all   d removes   D removes all finished   esc closes";
export const AGENTS_ALL_HINT = "↑↓ enter attaches   a hides older   d removes   D removes all finished   esc closes";

/**
 * Shown by default: a live agent, or a finished one that is not removed and either ran for a task that is still
 * open or was active in the last 24h. A finished agent with no known time stays shown (nothing says it is old).
 */
export function recentAgent(a: AgentInfo, now: number): boolean {
  if (a.live) return true;
  if (a.archived) return false;
  if (a.openTask) return true;
  const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : NaN;
  return Number.isNaN(at) || now - at < RECENT_AGENT_MS;
}

/** What a key in the open /agents menu asks for: nothing more (a redraw), or removing these agents' rows. */
export type AgentsKey = { handled: boolean; remove?: string[] };

/** How the menu draws: `row` is one agent's text (header/agent-clock agentRow); bold/dim come from components. */
export interface AgentsLook { row(a: AgentInfo, now: number): string; bold(s: string): string; dim(s: string): string }

/** The /agents menu's list and its view state. */
export class AgentsList {
  all = false;
  status = "";
  confirm: { names: string[]; label: string } | null = null;
  constructor(public agents: AgentInfo[], private readonly look: AgentsLook) {}

  /** The agents the menu shows, in listAgents' order (live first, latest activity first). */
  shown(now: number): AgentInfo[] {
    return this.all ? this.agents : this.agents.filter((a) => recentAgent(a, now));
  }

  /** Rows and footer at `now`: a removed row (only under `a`) is marked; the footer is the confirm or status, the hidden count and the hint. */
  view(now: number): { items: string[]; footer: string[] } {
    const { row, bold, dim } = this.look;
    const shown = this.shown(now);
    const hidden = this.agents.length - shown.length;
    const head = this.confirm ? [bold(`remove ${this.confirm.label} from /agents? y/n`) + dim("   transcripts stay")] : this.status ? [this.status] : [];
    return {
      items: shown.map((a) => row(a, now) + (a.archived ? dim(" · removed") : "")),
      footer: [...head, ...(hidden ? [dim(`+${hidden} older hidden`)] : !shown.length ? [dim("no agents")] : []), dim(this.all ? AGENTS_ALL_HINT : AGENTS_HINT)],
    };
  }

  /**
   * One key. While a removal waits for y/n it owns every key: a plain y or Y confirms, anything else cancels.
   * Otherwise `a` toggles all, `d` asks to remove the selected finished agent and `D` every finished one; a live agent is refused.
   */
  key(text: string | undefined, selected: AgentInfo | undefined): AgentsKey {
    const { dim } = this.look;
    if (this.confirm) {
      const names = this.confirm.names;
      this.confirm = null;
      this.status = "";
      return text === "y" || text === "Y" ? { handled: true, remove: names } : { handled: true };
    }
    if (text === "a") { this.all = !this.all; this.status = ""; return { handled: true }; }
    if (text === "d") {
      if (!selected) return { handled: true };
      if (selected.live) this.status = dim(`${selected.name} is live; stop it (ctrl+c in its view) before removing its row`);
      else if (selected.archived) this.status = dim(`${selected.name} is already removed`);
      else { this.confirm = { names: [selected.name], label: selected.name }; this.status = ""; }
      return { handled: true };
    }
    if (text === "D") {
      const finished = this.agents.filter((a) => !a.live && !a.archived).map((a) => a.name);
      if (!finished.length) this.status = dim("no finished agents to remove");
      else { this.confirm = { names: finished, label: `${finished.length} finished ${finished.length === 1 ? "agent" : "agents"}` }; this.status = ""; }
      return { handled: true };
    }
    return { handled: false };
  }

  /** The outcome of a removal, as the status line. */
  removed(result: { archived: string[]; live: string[] }): void {
    const { dim } = this.look;
    const n = result.archived.length;
    this.status = dim(`removed ${n} ${n === 1 ? "agent" : "agents"} from /agents${result.live.length ? `; kept ${result.live.join(", ")} (live)` : ""}; transcripts stay`);
  }
}
