// Bind conversations to a user's checkout; never copy its repository or credentials.
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, rmdir, lstat, unlink } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { paths, writeProjectState, repositoryBinding, initializeConversationStorage, siblingWorktreeFolder, type RepositoryBinding } from "../../../config";
import { attachConversation } from "./catalog";
import { refreshProjectFolders, withFolderLock } from "./folders";
import { command } from "../../proc";

/** Canonical checkout root, retaining local config and files even when origin exists. */
export async function checkoutHere(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  if (!Bun.which("git")) return null;
  const top = await command(["git", "rev-parse", "--show-toplevel"], cwd);
  return top.code === 0 ? realpathSync(top.out.trim()) : null;
}

/** Git groups subdirectories by checkout; ordinary folders have their own identity. */
export async function directoryHere(cwd: string): Promise<string | null> {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return null;
  return await checkoutHere(cwd) ?? realpathSync(cwd);
}

async function defaultBranch(directory: string): Promise<string> {
  const remote = await command(["git", "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], directory);
  if (remote.code === 0) return remote.out.trim().replace(/^origin\//, "");
  for (const branch of ["main", "master"]) {
    if ((await command(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], directory)).code === 0) return branch;
  }
  // An unborn main/master is a valid original checkout too.
  const head = await command(["git", "symbolic-ref", "--short", "-q", "HEAD"], directory);
  if (head.code === 0 && ["main", "master"].includes(head.out.trim())) return head.out.trim();
  throw new Error("cannot determine the default branch; set origin/HEAD or create main before starting orca");
}

async function requireBranch(directory: string, branch: string): Promise<void> {
  const head = await command(["git", "symbolic-ref", "--short", "-q", "HEAD"], directory);
  if (head.code !== 0 || head.out.trim() !== branch) {
    throw new Error(`main agent requires ${directory} on ${branch}; switch it yourself when safe (checkout was left unchanged)`);
  }
}

export async function assertMainCheckout(project: string): Promise<void> {
  const binding = repositoryBinding(project);
  if (binding?.branch) await requireBranch(binding.directory, binding.branch);
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Caller owns the project-state lock. Existing bindings and legacy clones are immutable. */
export async function initializeWorkspace(project: string, source?: string): Promise<void> {
  if (repositoryBinding(project) || existsSync(paths.repo(project))) {
    attachConversation(project);
    if (source && await directoryHere(source) !== realpathSync(paths.repo(project))) {
      throw new Error(`${project} already uses another checkout; create a new project for this directory`);
    }
    return;
  }
  const directory = await originalCheckout(source ?? process.cwd());
  const branch = await checkoutHere(directory) ? await defaultBranch(directory) : "";
  if (branch) await requireBranch(directory, branch);
  const binding: RepositoryBinding = { version: 1, directory, branch, worktreeId: crypto.randomUUID() };
  initializeConversationStorage(paths.root);
  await mkdir(paths.project(project), { recursive: true });
  await mkdir(paths.cache(project), { recursive: true });
  writeProjectState(project, "repository", binding);
  attachConversation(project);
  await withFolderLock(async () => refreshProjectFolders());
}

async function originalCheckout(source: string): Promise<string> {
  const directory = await directoryHere(source);
  if (!directory) throw new Error("start from an existing local directory or pass its path");
  await mkdir(paths.root, { recursive: true });
  const state = realpathSync(paths.root);
  if (inside(state, directory) || inside(directory, state)) {
    throw new Error("the original checkout and ORCA_HOME must be separate directories");
  }
  if (!await checkoutHere(directory)) return directory;
  // A linked worktree is for workers; the first Git worktree is the original checkout.
  const trees = await command(["git", "worktree", "list", "--porcelain", "-z"], directory);
  if (trees.code !== 0 || trees.out.split("\0")[0] !== `worktree ${directory}`) {
    throw new Error("start orca in the original checkout, not a linked worker worktree");
  }
  return directory;
}

/** Refuse stale paths, other repositories and slug collisions before reuse or removal. */
export async function assertWorktree(project: string, directory: string, branch?: string): Promise<void> {
  if (realpathSync(directory) === realpathSync(paths.repo(project))) throw new Error("refusing to use the original checkout as a worker worktree");
  const common = async (cwd: string) => {
    const result = await command(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    if (result.code !== 0) throw new Error(`cannot identify worktree at ${cwd}`);
    return realpathSync(result.out.trim());
  };
  if (await checkoutHere(directory) !== realpathSync(directory) || await common(directory) !== await common(paths.repo(project))) {
    throw new Error(`worktree at ${directory} belongs to another checkout`);
  }
  if (branch) {
    const head = await command(["git", "symbolic-ref", "--short", "-q", "HEAD"], directory);
    if (head.code !== 0 || head.out.trim() !== branch) throw new Error(`worktree at ${directory} is not on ${branch}`);
  }
}

/** Preflight before stopping a daemon. Finder metadata is not a worktree; all
 * other unexpected entries remain intact and get a path-specific diagnostic. */
async function checkProjectWorktrees(project: string): Promise<{ root: string; entries: string[] }[]> {
  if (!repositoryBinding(project)?.branch) return []; // Ordinary directories have no owned worktrees.
  const found: { root: string; entries: string[] }[] = [];
  for (const root of paths.worktreeRoots(project)) {
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`worktree folder is not a regular directory; preserved: ${root}`);
    const entries = await readdir(root, { withFileTypes: true }), directories: string[] = [];
    for (const entry of entries) {
      const dir = join(root, entry.name);
      if (entry.name === ".DS_Store" && entry.isFile()) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`unexpected file in worktree folder; move it before deleting this conversation: ${dir}`);
      try { await assertWorktree(project, dir); }
      catch (error) { throw new Error(`cannot inspect worktree ${dir}: ${error instanceof Error ? error.message : error}; conversation and files preserved`); }
      const status = await command(["git", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], dir);
      if (status.code !== 0 || status.out.trim()) throw new Error(`worktree has local files or changes; keep or remove it before deleting this project: ${dir}`);
      directories.push(entry.name);
    }
    found.push({ root, entries: directories });
  }
  return found;
}

/** Delete only clean linked worktrees. Retain local branches and never remove the original checkout. */
export async function removeProjectWorktrees(project: string, options: { dryRun?: boolean } = {}): Promise<void> {
  if (!repositoryBinding(project)?.branch) return;
  const found = await checkProjectWorktrees(project); // Every folder is checked before anything is removed.
  if (options.dryRun) return;
  for (const { root, entries } of found) {
    for (const entry of entries) {
      const result = await command(["git", "worktree", "remove", join(root, entry)], paths.repo(project));
      if (result.code !== 0) throw new Error(`could not remove worktree: ${result.err.trim()}`);
    }
    const metadata = join(root, ".DS_Store");
    const st = await lstat(metadata).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (st?.isFile()) await unlink(metadata);
    if (existsSync(root)) await rmdir(root);
    // The sibling folder older builds made goes with its last namespace; one that still holds anything stays.
    if (siblingWorktreeFolder(dirname(root))) await rmdir(dirname(root)).catch(() => {});
  }
}
/** Validate a directory before a metadata-only relink, leaving the old binding untouched on failure. */
export async function validateProjectDirectory(source: string): Promise<{ directory: string; branch: string }> {
  const directory = await originalCheckout(source);
  const branch = await checkoutHere(directory) ? await defaultBranch(directory) : "";
  if (branch) await requireBranch(directory, branch);
  return { directory, branch };
}
