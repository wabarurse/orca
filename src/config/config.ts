import { paths } from "./paths";
// Compatibility for callers within this package; public consumers use config/index.ts.
export { paths, repositoryBinding, type RepositoryBinding } from "./paths";

export interface Config {
  /** Full access preserves existing installs; workspace uses an OS write sandbox and fails closed if unavailable. */
  sandbox: "off" | "workspace";
  model: string;
  compact: boolean;
  /** Upper working-context target for workers/reviewers; original history stays on disk. */
  workerContextTokens: number;
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
  /** Projects pinned to the top of the TUI's project list. */
  pinned: string[];
}

export const defaults: Config = {
  sandbox: "off",
  model: "claude-sonnet-5-5",
  compact: true,
  workerContextTokens: 128000,
  contextLimitFallback: 128000,
  account: "",
  openaiAccount: "",
  anthropicPromptCache: true,
  toolConcurrency: 4,
  maxToolOutputBytes: 64 * 1024 * 1024,
  maxToolResultBytes: 16 * 1024,
  pinned: [],
};

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
  // The orchestrator now compacts at a fraction of the selected model's window (rolling-memory.ts).
  // Do not let a saved absolute target restore the old 32k policy or persist it on save.
  for (const key of ["orchestratorContextTokens", "maxReviewRounds", "dynamicDispatch", "cyclomatic", "cognitive"]) delete (parsed as Record<string, unknown>)[key];
  return withFallbacks({ ...defaults, ...parsed });
}

/** Invalid saved values read as their defaults. */
function withFallbacks(config: Config): Config {
  if (config.sandbox !== "off" && config.sandbox !== "workspace") throw new Error("sandbox must be off or workspace; no execution fallback is permitted");
  if (typeof config.anthropicPromptCache !== "boolean") config.anthropicPromptCache = defaults.anthropicPromptCache;
  if (!integerWithin(config.toolConcurrency, 1, 32)) config.toolConcurrency = defaults.toolConcurrency;
  if (!integerWithin(config.maxToolResultBytes, 512, 65536)) config.maxToolResultBytes = defaults.maxToolResultBytes;
  if (!integerWithin(config.maxToolOutputBytes, 1024, 256 * 1024 * 1024)) config.maxToolOutputBytes = defaults.maxToolOutputBytes;
  if (!integerWithin(config.workerContextTokens, 16000, 1000000)) config.workerContextTokens = defaults.workerContextTokens;
  return config;
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
