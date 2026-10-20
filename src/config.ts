// Everything lives under ~/.parallels, like ~/.claude.
//
//   ~/.parallels/
//     config.toml              model, byte limits, defaults
//     prompts/                 orchestrator.md, worker.md, reviewer.md
//     projects/<name>/
//       repo/                  the orchestrator's clone
//       worktrees/<task-id>/   one per worker, removed when done
//       tasks.json             [{id, branch, status, desc}]
//       inbox/                 one file per message to the orchestrator
//       transcripts/<id>.jsonl one per agent session

import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = process.env.PARALLELS_HOME ?? join(homedir(), ".parallels");

export const paths = {
  root: ROOT,
  config: join(ROOT, "config.toml"),
  prompts: join(ROOT, "prompts"),
  project: (name: string) => join(ROOT, "projects", name),
  repo: (name: string) => join(ROOT, "projects", name, "repo"),
  worktree: (name: string, taskId: string) => join(ROOT, "projects", name, "worktrees", taskId),
  tasks: (name: string) => join(ROOT, "projects", name, "tasks.json"),
  inbox: (name: string) => join(ROOT, "projects", name, "inbox"),
  transcript: (name: string, id: string) => join(ROOT, "projects", name, "transcripts", `${id}.jsonl`),
};

export interface Config {
  model: string;
  /** Max bytes a single tool result may occupy in the transcript. */
  maxToolResultBytes: number;
  /** Max review rounds before the reviewer gives up and reports to the orchestrator. */
  maxReviewRounds: number;
}

export const defaults: Config = {
  model: "claude-sonnet-5-5",
  maxToolResultBytes: 16 * 1024,
  maxReviewRounds: 2,
};

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(paths.config);
  if (!(await file.exists())) return defaults;
  const parsed = Bun.TOML.parse(await file.text()) as Partial<Config>;
  return { ...defaults, ...parsed };
}
