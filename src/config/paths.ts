// Storage locations and durable project metadata. Configuration parsing stays in config.ts.
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { readState, updateState, recoverStateScope, legacyStateScopes } from "./state-store";
import { conversationIdentity } from "./conversation-identity";
import { directoryProject, inheritedSettings, setDirectorySetting } from "./directory-projects";
import { siblingWorktreeRoots } from "./legacy";
import { conversationPath } from "./conversation-storage";

// Read lazily so tests can point ORCA_HOME at a temp dir after import.
const root = () => process.env.ORCA_HOME ?? join(homedir(), ".orca");
/** The installed checkout that `orca pull` updates, whatever ORCA_HOME says. */
export const installedApp = (home: string) => join(home, ".orca", ".runtime", "app");

// An empty branch explicitly binds an ordinary directory, without Git/worktree semantics.
export interface RepositoryBinding { version: 1; directory: string; branch: string; worktreeId: string }

/** Project incarnation prevents recreated names from inheriting prior settings or authority. */
export function projectStateScope(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("invalid project id");
  const parent = directoryProject(paths.memory, name);
  if (parent?.id === name) return `directory-project:${name}`;
  const identity = conversationIdentity(root(), name);
  const scope = `conversation:${identity.id}`;
  recoverStateScope(paths.memory, `project:${name}:`, identity.fingerprint, scope);
  return scope;
}
/** Historical identities only for the persisted conversation's original directory.
 * A recreated alias has a new fingerprint and cannot inherit these scopes. */
export function legacyProjectIdentities(name: string): string[] {
  const identity = conversationIdentity(root(), name), prefix = `project:${name}:`;
  return legacyStateScopes(paths.memory, prefix, identity.fingerprint).map(scope => scope.slice(prefix.length));
}
export function readProjectState<T>(name: string, key: string): T | undefined {
  let scope: string;
  try { scope = projectStateScope(name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const own = readState<T>(paths.memory, scope, key);
  if (own !== undefined) return own;
  const parent = directoryProject(paths.memory, name);
  return inheritedSettings.includes(key as typeof inheritedSettings[number]) ? parent?.defaults[key] as T | undefined : undefined;
}
export function writeProjectState<T>(name: string, key: string, value: T | undefined): void {
  const parent = directoryProject(paths.memory, name);
  if (parent?.id === name) { setDirectorySetting(paths.memory, name, key, value); return; }
  updateState<T>(paths.memory, projectStateScope(name), key, () => value);
}
/** Missing means an unbound/legacy project; corrupt metadata never falls back. */
export function repositoryBinding(name: string): RepositoryBinding | undefined {
  const value = readProjectState<RepositoryBinding>(name, "repository");
  if (value === undefined) return;
  if (value?.version !== 1 || typeof value.directory !== "string" || !isAbsolute(value.directory) ||
      typeof value.branch !== "string" || !/^[a-f0-9-]{36}$/.test(value.worktreeId)) {
    throw new Error(`invalid repository binding for ${name}`);
  }
  const parent = directoryProject(paths.memory, name);
  return parent ? { ...value, directory: parent.directory, branch: parent.branch } : value;
}

/** Worktrees live in the home, never beside the user's repositories: `worktrees/<repo>--<id>/<branch>`.
 * The id is the conversation's worktree namespace, so deleting one conversation cannot reach
 * another's worktrees and two checkouts with one folder name stay apart. Git records real
 * paths, so the home is resolved once it exists. */
function worktreeHome(binding: RepositoryBinding): string {
  let home = root();
  try { home = realpathSync(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const repo = basename(binding.directory).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "repo";
  return join(home, "worktrees", `${repo}--${binding.worktreeId.slice(0, 8)}`);
}
/** Every folder that may hold this conversation's worktrees: the current one first, then the
 * sibling folders older builds used, while they still exist. */
function worktreeRoots(name: string): string[] {
  const binding = repositoryBinding(name);
  if (!binding) return [join(conversationPath(root(), name), "worktrees")];
  return [worktreeHome(binding), ...siblingWorktreeRoots(binding.directory, binding.worktreeId)];
}
const worktrees = (name: string) => worktreeRoots(name)[0]!;
/** A worktree an older build created beside the checkout stays where Git registered it. */
function worktree(name: string, slug: string): string {
  const [current, ...older] = worktreeRoots(name);
  for (const root of older) {
    const path = join(root, slug);
    try { realpathSync(path); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return join(current!, slug);
}

export const paths = {
  get root() { return root(); },
  get config() { return join(root(), ".runtime", "config.toml"); },
  get memory() { return join(root(), "memory.sqlite"); },
  /** The user's MCP servers: one readable file they edit by hand (core/mcp/config.ts). */
  get mcp() { return join(root(), "mcp.json"); },
  get runtime() { return join(root(), ".runtime"); },
  runtimeProject: (name: string) => join(root(), ".runtime", "projects", name),
  /** The socket of orca's own tmux server, so a stale user server (started from a since-moved directory) cannot break agent windows. */
  get tmuxSocket() { return join(root(), ".runtime", "tmux.sock"); },
  daemonLock: (name: string) => join(root(), ".runtime", "daemon-locks", name),
  orchestrator: (name: string) => join(root(), ".runtime", "projects", name, "orchestrator"),
  get projects() { return join(root(), "projects"); },
  project: (name: string) => conversationPath(root(), name),
  inputHistory: (name: string) => join(root(), ".runtime", "projects", name, "input-history"),
  cache: (name: string) => join(conversationPath(root(), name), "cache"),
  repo: (name: string) => repositoryBinding(name)?.directory ?? join(conversationPath(root(), name), "repo"),
  worktrees,
  worktreeRoots,
  worktree: (name: string, slug: string) => repositoryBinding(name)?.branch === "" ? paths.repo(name) : worktree(name, slug),
  inbox: (name: string) => join(root(), ".runtime", "projects", name, "inbox"),
  runs: (name: string) => join(root(), ".runtime", "projects", name, "runs"),
  questions: (name: string) => join(root(), ".runtime", "projects", name, "questions"),
  transcript: (name: string, id: string) => join(conversationPath(root(), name), "transcript", `${id}.jsonl`),
};
