import { paths } from "./paths";
// Compatibility for callers within this package; public consumers use config/index.ts.
export { paths, repositoryBinding, type RepositoryBinding } from "./paths";

export interface Config {
  /** Full access preserves existing installs; workspace uses an OS write sandbox and fails closed if unavailable. */
  sandbox: "off" | "workspace";
  model: string;
  compact: boolean;
  contextLimitFallback: number;
  /** Claude subscription profile saved by /login anthropic. Empty = default. */
  account: string;
  /** Codex/ChatGPT subscription profile saved by /login openai. Empty = default. */
  openaiAccount: string;
  /** Reuse Claude request prefixes; cache reads still count toward context. */
  anthropicPromptCache: boolean;
  /** Maximum overlap for calls explicitly marked independent; 1 is sequential. */
  toolConcurrency: number;
  /** Maximum bytes saved per shell command before terminating its process group. */
  maxToolOutputBytes: number;
  /** Max bytes a single tool result may occupy in the transcript. */
  maxToolResultBytes: number;
  /** Default max review rounds for projects without their own (memory.sqlite project flow, /review-rounds); 0 skips review and goes straight to CI. */
  maxReviewRounds: number;
  /** Default /dynamic-dispatch switch for projects without their own; dormant until the orchestrator reads it. Default off. */
  dynamicDispatch: boolean;
  /** Complexity thresholds the reviewer reports against. */
  cyclomatic: number;
  cognitive: number;
  /** Projects pinned to the top of the TUI's project list. */
  pinned: string[];
}

export const defaults: Config = {
  sandbox: "off",
  model: "claude-sonnet-5-5",
  compact: true,
  contextLimitFallback: 128000,
  account: "",
  openaiAccount: "",
  anthropicPromptCache: true,
  toolConcurrency: 4,
  maxToolOutputBytes: 64 * 1024 * 1024,
  maxToolResultBytes: 16 * 1024,
  maxReviewRounds: 1,
  dynamicDispatch: false,
  cyclomatic: 10,
  cognitive: 15,
  pinned: [],
};

/** Most review rounds /review-rounds, project flow records and config.toml accept. */
export const MAX_REVIEW_ROUNDS = 100;

/** The last parse warning, so a broken file is reported once, not on every load. */
let warned = "";

export async function loadConfig(options: { strict?: boolean } = {}): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return defaults;
  let parsed: Partial<Config>;
  try {
    parsed = Bun.TOML.parse(await file.text()) as Partial<Config>;
  } catch (err) {
    // UI reads may recover so the user can repair configuration. Execution must
    // never silently turn a requested sandbox into full access.
    if (options.strict) throw new Error(`invalid execution configuration ${paths.config}: ${String(err)}`);
    const warning = `orca: ignoring ${paths.config}: ${err instanceof Error ? err.message : String(err)}`;
    if (warning !== warned) console.error(warning);
    warned = warning;
    return defaults;
  }
  // The orchestrator now uses half of the selected model's window. Do not let
  // a saved absolute target restore the old 32k policy or persist it on save.
  delete (parsed as Record<string, unknown>).orchestratorContextTokens;
  return withFallbacks({ ...defaults, ...parsed });
}

/** Invalid saved values read as their defaults. */
function withFallbacks(config: Config): Config {
  if (config.sandbox !== "off" && config.sandbox !== "workspace") throw new Error("sandbox must be off or workspace; no execution fallback is permitted");
  if (typeof config.anthropicPromptCache !== "boolean") config.anthropicPromptCache = defaults.anthropicPromptCache;
  if (!integerWithin(config.toolConcurrency, 1, 32)) config.toolConcurrency = defaults.toolConcurrency;
  if (!integerWithin(config.maxToolResultBytes, 512, 65536)) config.maxToolResultBytes = defaults.maxToolResultBytes;
  if (!integerWithin(config.maxToolOutputBytes, 1024, 256 * 1024 * 1024)) config.maxToolOutputBytes = defaults.maxToolOutputBytes;
  if (!validRounds(config.maxReviewRounds)) config.maxReviewRounds = defaults.maxReviewRounds;
  if (typeof config.dynamicDispatch !== "boolean") config.dynamicDispatch = defaults.dynamicDispatch;
  return config;
}

/** A review round count: an integer from 0 to MAX_REVIEW_ROUNDS. */
export function validRounds(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_REVIEW_ROUNDS;
}

/** Write changed keys back to config.toml, keeping the others. */
export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  const lines = Object.entries(next).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  await Bun.write(paths.config, lines.join("\n") + "\n");
  return next;
}

function integerWithin(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
