// Bind conversations to a user's checkout; never copy its repository or credentials.
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { paths, writeProjectState, repositoryBinding, type RepositoryBinding } from "../../../config";
import { attachConversation } from "./catalog";
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

/** What the orchestrator is told about the user's checkout, every turn. It may be on any branch: workers start
 * from the default branch by name whatever is checked out, so the checkout only has to be described, never moved.
 * Empty for an ordinary directory and for legacy clone-based projects. */
export async function checkoutNote(project: string): Promise<string> {
  const binding = repositoryBinding(project);
  if (!binding?.branch) return "";
  const head = await command(["git", "symbolic-ref", "--short", "-q", "HEAD"], binding.directory);
  const current = head.code === 0 ? head.out.trim() : "";
  const where = current === binding.branch ? `on its default branch ${binding.branch}`
    : `${current ? `on branch ${current}` : "not on a branch (detached HEAD)"}, not the default branch ${binding.branch}: what is only there is not in a new worker branch`;
  return `Original checkout ${binding.directory} is ${where}. It is the user's working copy: read it freely, but do not switch its branch, stash or commit in it unless the user asks. Workers start from ${binding.branch} in worktrees orca creates under ${paths.root} through spawn; never create a worktree yourself (git worktree add is refused).`;
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
  const binding: RepositoryBinding = { version: 1, directory, branch, worktreeId: crypto.randomUUID() };
  await mkdir(paths.project(project), { recursive: true });
  await mkdir(paths.cache(project), { recursive: true });
  writeProjectState(project, "repository", binding);
  attachConversation(project);
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

/** Validate a directory before a metadata-only relink, leaving the old binding untouched on failure. */
export async function validateProjectDirectory(source: string): Promise<{ directory: string; branch: string }> {
  const directory = await originalCheckout(source);
  const branch = await checkoutHere(directory) ? await defaultBranch(directory) : "";
  return { directory, branch };
}
