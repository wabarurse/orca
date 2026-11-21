// config.toml: the user's settings, edited by hand or by orca2 commands.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "./paths";

export type Runner = "plain" | string;

export type Config = {
  model: string;
  /** Claude subscription profile; "" is "default". */
  account: string;
  /** Codex subscription profile; "" is "default". */
  openaiAccount: string;
  anthropicPromptCache: boolean;
  /** Background summaries on the account's small model (Haiku, Luna). */
  smallSummaries: boolean;
  toolConcurrency: number;
  maxToolResultBytes: number;
  maxToolOutputBytes: number;
  /** Plugins switched on everywhere; a bubble's own on/off lists change this per bubble. */
  plugins: string[];
  /** Plugins orca wrote that the user approved; any other user plugin is refused until approved. */
  approved: string[];
  /** Folders whose instructions, skills and plugins load without asking (project trust). */
  trusted: string[];
  /** Folders the user said not to trust. */
  untrusted: string[];
  /** Which runner starts new agents: "plain" (child processes) or an enabled runner plugin's name. */
  runner: Runner;
};

export const defaults: Config = {
  model: "claude-sonnet-5-5",
  account: "",
  openaiAccount: "",
  anthropicPromptCache: true,
  smallSummaries: true,
  toolConcurrency: 4,
  maxToolResultBytes: 16 * 1024,
  maxToolOutputBytes: 64 * 1024 * 1024,
  plugins: [],
  approved: [],
  trusted: [],
  untrusted: [],
  runner: "plain",
};

let warned = "";

const strings = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string") ? value : fallback;
const integer = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
const text = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;
const flag = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;

/** Parse saved settings; a value of the wrong shape reads as its default. */
export function parseConfig(raw: Record<string, unknown>): Config {
  return {
    model: text(raw.model, defaults.model),
    account: text(raw.account, defaults.account),
    openaiAccount: text(raw.openaiAccount, defaults.openaiAccount),
    anthropicPromptCache: flag(raw.anthropicPromptCache, defaults.anthropicPromptCache),
    smallSummaries: flag(raw.smallSummaries, defaults.smallSummaries),
    toolConcurrency: integer(raw.toolConcurrency, 1, 32, defaults.toolConcurrency),
    maxToolResultBytes: integer(raw.maxToolResultBytes, 512, 65536, defaults.maxToolResultBytes),
    maxToolOutputBytes: integer(raw.maxToolOutputBytes, 1024, 256 * 1024 * 1024, defaults.maxToolOutputBytes),
    plugins: strings(raw.plugins, defaults.plugins),
    approved: strings(raw.approved, defaults.approved),
    trusted: strings(raw.trusted, defaults.trusted),
    untrusted: strings(raw.untrusted, defaults.untrusted),
    runner: text(raw.runner, defaults.runner),
  };
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return { ...defaults };
  try {
    const parsed: unknown = Bun.TOML.parse(await file.text());
    return parseConfig(typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {});
  } catch (error) {
    const warning = `orca2: ignoring ${paths.config}: ${error instanceof Error ? error.message : String(error)}`;
    if (warning !== warned) console.error(warning);
    warned = warning;
    return { ...defaults };
  }
}

/** Write changed keys back, keeping the others. */
export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  await Bun.write(paths.config, Object.entries(next).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n") + "\n");
  return next;
}
