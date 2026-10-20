// Everything lives under ~/.parallels, like ~/.claude.
//
//   ~/.parallels/
//     config.toml              model, byte limits, defaults
//     projects/<name>/
//       repo/                  the orchestrator's clone
//       worktrees/<branch>/    one per branch, removed when done
//       inbox/<agent>/         one FIFO queue per agent (orchestrator, user, worker-<branch>, ...)
//       transcripts/<role>-<branch>.jsonl   one per agent; the only memory

import { homedir } from "node:os";
import { join } from "node:path";

// Read lazily so tests can point PARALLELS_HOME at a temp dir after import.
const root = () => process.env.PARALLELS_HOME ?? join(homedir(), ".parallels");

export const paths = {
  get root() { return root(); },
  get config() { return join(root(), "config.toml"); },
  project: (name: string) => join(root(), "projects", name),
  repo: (name: string) => join(root(), "projects", name, "repo"),
  worktree: (name: string, slug: string) => join(root(), "projects", name, "worktrees", slug),
  inbox: (name: string) => join(root(), "projects", name, "inbox"),
  transcript: (name: string, id: string) => join(root(), "projects", name, "transcripts", `${id}.jsonl`),
};

export interface Config {
  model: string;
  /** Claude subscription profile saved by /login anthropic. Empty = default. */
  account: string;
  /** Max bytes a single tool result may occupy in the transcript. */
  maxToolResultBytes: number;
  /** Max review rounds before the reviewer gives up and reports to the orchestrator. */
  maxReviewRounds: number;
}

export const defaults: Config = {
  model: "claude-sonnet-5-5",
  account: "",
  maxToolResultBytes: 16 * 1024,
  maxReviewRounds: 2,
};

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return defaults;
  const parsed = Bun.TOML.parse(await file.text()) as Partial<Config>;
  return { ...defaults, ...parsed };
}

/** Write changed keys back to config.toml, keeping the others. */
export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  const lines = Object.entries(next).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  await Bun.write(paths.config, lines.join("\n") + "\n");
  return next;
}
