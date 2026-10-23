// Bind conversations to a user's checkout; never copy its repository or credentials.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { paths, repositoryBinding, type RepositoryBinding } from "./config";
import { command } from "./proc";

/** Canonical checkout root, retaining local config and files even when origin exists. */
export async function checkoutHere(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  const top = await command(["git", "rev-parse", "--show-toplevel"], cwd);
  return top.code === 0 ? realpathSync(top.out.trim()) : null;
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
  throw new Error("cannot determine the default branch; set origin/HEAD or create main before starting parallels");
}

async function requireBranch(directory: string, branch: string): Promise<void> {
  const head = await command(["git", "symbolic-ref", "--short", "-q", "HEAD"], directory);
  if (head.code !== 0 || head.out.trim() !== branch) {
    throw new Error(`main agent requires ${directory} on ${branch}; switch it yourself when safe (checkout was left unchanged)`);
  }
}

export async function assertMainCheckout(project: string): Promise<void> {
  const binding = repositoryBinding(project);
  if (binding) await requireBranch(binding.directory, binding.branch);
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Caller owns the project-state lock. Existing bindings and legacy clones are immutable. */
export async function initializeWorkspace(project: string, source?: string): Promise<void> {
  if (repositoryBinding(project) || existsSync(paths.repo(project))) {
    if (source && await checkoutHere(source) !== realpathSync(paths.repo(project))) {
      throw new Error(`${project} already uses another checkout; create a new project for this directory`);
    }
    return;
  }
  const directory = await originalCheckout(source ?? process.cwd());
  const branch = await defaultBranch(directory);
  await requireBranch(directory, branch);
  const binding: RepositoryBinding = { version: 1, directory, branch, worktreeId: crypto.randomUUID() };
  await mkdir(paths.project(project), { recursive: true });
  const temp = `${paths.repository(project)}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify(binding) + "\n");
    await rename(temp, paths.repository(project));
  } finally { await rm(temp, { force: true }); }
}

async function originalCheckout(source: string): Promise<string> {
  const directory = await checkoutHere(source);
  if (!directory) throw new Error("start from a local Git checkout or pass its directory; clone remote repositories yourself first");
  await mkdir(paths.root, { recursive: true });
  const state = realpathSync(paths.root);
  if (inside(state, directory) || inside(directory, state)) {
    throw new Error("the original checkout and PARALLELS_HOME must be separate directories");
  }
  // A linked worktree is for workers; the first Git worktree is the original checkout.
  const trees = await command(["git", "worktree", "list", "--porcelain", "-z"], directory);
  if (trees.code !== 0 || trees.out.split("\0")[0] !== `worktree ${directory}`) {
    throw new Error("start parallels in the original checkout, not a linked worker worktree");
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

/** Delete only clean linked worktrees. Retain local branches and never remove the original checkout. */
export async function removeProjectWorktrees(project: string): Promise<void> {
  if (!repositoryBinding(project)) return; // Legacy worktrees are still inside the project directory.
  const root = paths.worktrees(project);
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries) {
    const dir = join(root, entry);
    await assertWorktree(project, dir);
    const status = await command(["git", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], dir);
    if (status.code !== 0 || status.out.trim()) throw new Error(`worktree has local files or changes; keep or remove it before deleting this project: ${dir}`);
  }
  for (const entry of entries) {
    const result = await command(["git", "worktree", "remove", join(root, entry)], paths.repo(project));
    if (result.code !== 0) throw new Error(`could not remove worktree: ${result.err.trim()}`);
  }
  if (existsSync(root)) await rmdir(root);
}
