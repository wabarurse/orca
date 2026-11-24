import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { paths } from "./paths";
import { errorMessage } from "./result";

const Table = z.record(z.string(), z.unknown());

export type Runner = "plain" | string;

export type Config = {
  model: string;
  account: string;
  openaiAccount: string;
  anthropicPromptCache: boolean;
  smallSummaries: boolean;
  toolConcurrency: number;
  maxToolResultBytes: number;
  maxToolOutputBytes: number;
  plugins: string[];
  approved: string[];
  untrusted: string[];
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
    untrusted: strings(raw.untrusted, defaults.untrusted),
    runner: text(raw.runner, defaults.runner),
  };
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return { ...defaults };
  try {
    const parsed: unknown = Bun.TOML.parse(await file.text());
    const table = Table.safeParse(parsed);
    return parseConfig(table.success ? table.data : {});
  } catch (error) {
    const warning = `orca2: ignoring ${paths.config}: ${errorMessage(error)}`;
    if (warning !== warned) console.error(warning);
    warned = warning;
    return { ...defaults };
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  await Bun.write(paths.config, Object.entries(next).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n") + "\n");
  return next;
}
