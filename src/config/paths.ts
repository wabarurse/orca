// Storage locations and durable project metadata. Configuration parsing stays in config.ts.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { statSync } from "node:fs";
import { readState, updateState } from "./state-store";
import { stateRoot, worktreeRoot } from "./legacy";

// Read lazily so tests can point ORCA_HOME at a temp dir after import.
const root = () => stateRoot(homedir(), process.env);

export interface RepositoryBinding { version: 1; directory: string; branch: string; worktreeId: string }

/** Project incarnation prevents recreated names from inheriting prior settings or authority. */
export function projectStateScope(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("invalid project id");
  const s = statSync(join(root(), "projects", name), { bigint: true });
  return `project:${name}:${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export function readProjectState<T>(name: string, key: string): T | undefined {
  let scope: string;
  try { scope = projectStateScope(name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  return readState<T>(paths.memory, scope, key);
}
export function writeProjectState<T>(name: string, key: string, value: T | undefined): void {
  updateState<T>(paths.memory, projectStateScope(name), key, () => value);
}
/** Missing means an unbound/legacy project; corrupt metadata never falls back. */
export function repositoryBinding(name: string): RepositoryBinding | undefined {
  const value = readProjectState<RepositoryBinding>(name, "repository");
  if (value === undefined) return;
  if (value?.version !== 1 || typeof value.directory !== "string" || !isAbsolute(value.directory) ||
      typeof value.branch !== "string" || !value.branch || !/^[a-f0-9-]{36}$/.test(value.worktreeId)) {
    throw new Error(`invalid repository binding for ${name}`);
  }
  return value;
}

function worktrees(name: string): string {
  const binding = repositoryBinding(name);
  return binding ? worktreeRoot(binding.directory, binding.worktreeId) : join(root(), "projects", name, "worktrees");
}

export const paths = {
  get root() { return root(); },
  get config() { return join(root(), ".runtime", "config.toml"); },
  get memory() { return join(root(), "memory.sqlite"); },
  get runtime() { return join(root(), ".runtime"); },
  runtimeProject: (name: string) => join(root(), ".runtime", "projects", name),
  /** The socket of orca's own tmux server, so a stale user server (started from a since-moved directory) cannot break agent windows. */
  get tmuxSocket() { return join(root(), ".runtime", "tmux.sock"); },
  daemonLock: (name: string) => join(root(), ".runtime", "daemon-locks", name),
  orchestrator: (name: string) => join(root(), ".runtime", "projects", name, "orchestrator"),
  get projects() { return join(root(), "projects"); },
  project: (name: string) => join(root(), "projects", name),
  inputHistory: (name: string) => join(root(), ".runtime", "projects", name, "input-history"),
  cache: (name: string) => join(root(), "projects", name, "cache"),
  repo: (name: string) => repositoryBinding(name)?.directory ?? join(root(), "projects", name, "repo"),
  worktrees,
  worktree: (name: string, slug: string) => join(worktrees(name), slug),
  inbox: (name: string) => join(root(), ".runtime", "projects", name, "inbox"),
  runs: (name: string) => join(root(), ".runtime", "projects", name, "runs"),
  questions: (name: string) => join(root(), ".runtime", "projects", name, "questions"),
  transcript: (name: string, id: string) => join(root(), "projects", name, "transcript", `${id}.jsonl`),
};
