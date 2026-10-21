// Everything lives under ~/.parallels, like ~/.claude.
//
//   ~/.parallels/
//     config.toml              model, byte limits, defaults, pinned projects
//     projects/<name>/
//       name                   display name set by /rename (absent = <name>)
//       input-history          the TUI's ↑/↓ input history, one JSON string per line, newest last
//       repo/                  the orchestrator's clone
//       worktrees/<branch>/    one per branch, removed when done
//       inbox/<agent>/         one FIFO queue per agent (orchestrator, user, worker-<branch>, ...)
//       runs/<agent>.json       the agent's current run: run id, pid, reported or running, last step (src/exits.ts)
//       runs/<agent>.<run>.exit a run's close claim: created once, by whoever sends its exit notice (or none)
//       questions/             the orchestrator's open questions for the user, a file each
//       transcripts/<role>-<branch>.jsonl   one per agent; the only memory

import { homedir } from "node:os";
import { join } from "node:path";

// Read lazily so tests can point PARALLELS_HOME at a temp dir after import.
const root = () => process.env.PARALLELS_HOME ?? join(homedir(), ".parallels");

export const paths = {
  get root() { return root(); },
  get config() { return join(root(), "config.toml"); },
  project: (name: string) => join(root(), "projects", name),
  displayName: (name: string) => join(root(), "projects", name, "name"),
  inputHistory: (name: string) => join(root(), "projects", name, "input-history"),
  repo: (name: string) => join(root(), "projects", name, "repo"),
  worktree: (name: string, slug: string) => join(root(), "projects", name, "worktrees", slug),
  inbox: (name: string) => join(root(), "projects", name, "inbox"),
  runs: (name: string) => join(root(), "projects", name, "runs"),
  questions: (name: string) => join(root(), "projects", name, "questions"),
  transcript: (name: string, id: string) => join(root(), "projects", name, "transcripts", `${id}.jsonl`),
};

export interface Config {
  model: string;
  /** Claude subscription profile saved by /login anthropic. Empty = default. */
  account: string;
  /** Codex/ChatGPT subscription profile saved by /login openai. Empty = default. */
  openaiAccount: string;
  /** Max bytes a single tool result may occupy in the transcript. */
  maxToolResultBytes: number;
  /** Max review rounds before the orchestrator reports what is still open; 0 skips review and goes straight to CI. */
  maxReviewRounds: number;
  /** Complexity thresholds the reviewer reports against. */
  cyclomatic: number;
  cognitive: number;
  /** Projects pinned to the top of the TUI's project list. */
  pinned: string[];
}

export const defaults: Config = {
  model: "claude-sonnet-5-5",
  account: "",
  openaiAccount: "",
  maxToolResultBytes: 16 * 1024,
  maxReviewRounds: 1,
  cyclomatic: 10,
  cognitive: 15,
  pinned: [],
};

/** Most review rounds /review-rounds and config.toml accept. */
export const MAX_REVIEW_ROUNDS = 100;

/** The last parse warning, so a broken file is reported once, not on every load. */
let warned = "";

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return defaults;
  let parsed: Partial<Config>;
  try {
    parsed = Bun.TOML.parse(await file.text()) as Partial<Config>;
  } catch (err) {
    // A broken config.toml must not break every command and turn.
    const warning = `parallels: ignoring ${paths.config}: ${err instanceof Error ? err.message : String(err)}`;
    if (warning !== warned) console.error(warning);
    warned = warning;
    return defaults;
  }
  const config = { ...defaults, ...parsed };
  if (!validRounds(config.maxReviewRounds)) config.maxReviewRounds = defaults.maxReviewRounds;
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
