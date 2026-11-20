// /mux: which terminal multiplexer new agents start in, saved as `mux` in config.toml. A switch moves nothing:
// agents already running stay where they are, and orca keeps watching and stopping them there (core/tmux/runner.ts mux).
import { loadConfig, muxes, saveConfig, type Mux } from "../../config";
import { mux as multiplexer } from "../../core/tmux";
import type { Choice } from "./model";

export interface MuxHost {
  open(title: string, choices: Choice<Mux>[], pick: (mux: Mux) => Promise<void>): void;
  note(text: string): void;
}

const LABELS: Record<Mux, string> = { tmux: "tmux · orca's own tmux server", rex: "rex · a Rex session per conversation" };

/** Save `mux` and say what it changes; Rex must be installed to be chosen. */
export async function setMux(mux: Mux): Promise<string> {
  if (mux === "rex" && !multiplexer.rexInstalled()) return "Rex is not installed; agents stay on tmux";
  await saveConfig({ mux });
  return `new agents start in ${mux}; running ones stay where they are`;
}

/** `/mux` opens the choice, `/mux tmux|rex` sets it at once. */
export async function chooseMux(args: string, host: MuxHost): Promise<void> {
  const current = (await loadConfig()).mux, wanted = args.trim();
  if (wanted) return host.note(muxes.includes(wanted as Mux) ? await setMux(wanted as Mux) : `unknown multiplexer ${wanted}; choose ${muxes.join(" or ")}`);
  host.open("multiplexer new agents start in   (/mux tmux|rex sets directly)", muxes.map(value => ({ value, label: LABELS[value], current: value === current })),
    async mux => host.note(await setMux(mux)));
}
