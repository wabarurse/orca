// Everything lives under ~/.parallels, like ~/.claude.
//
//   ~/.parallels/
//     config.toml              model, byte limits, defaults
//     projects/<name>/
//       name                   display name set by /rename (absent = <name>)
//       repo/                  the orchestrator's clone
//       worktrees/<branch>/    one per branch, removed when done
//       inbox/<agent>/         one FIFO queue per agent (orchestrator, user, worker-<branch>, ...)
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
  repo: (name: string) => join(root(), "projects", name, "repo"),
  worktree: (name: string, slug: string) => join(root(), "projects", name, "worktrees", slug),
  inbox: (name: string) => join(root(), "projects", name, "inbox"),
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
}

export const defaults: Config = {
  model: "claude-sonnet-5-5",
  account: "",
  openaiAccount: "",
  maxToolResultBytes: 16 * 1024,
  maxReviewRounds: 1,
  cyclomatic: 10,
  cognitive: 15,
};

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return defaults;
  const parsed = Bun.TOML.parse(await file.text()) as Partial<Config>;
  const config = { ...defaults, ...parsed };
  if (!validRounds(config.maxReviewRounds)) config.maxReviewRounds = defaults.maxReviewRounds;
  return config;
}

/** A review round count: a non-negative integer. */
export function validRounds(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Write changed keys back to config.toml, keeping the others. */
export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  const lines = Object.entries(next).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  await Bun.write(paths.config, lines.join("\n") + "\n");
  return next;
}
