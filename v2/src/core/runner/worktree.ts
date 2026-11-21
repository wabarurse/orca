// Worker checkouts: in a Git repository each branch gets a worktree under ~/.orca2/worktrees/<conversation>/,
// cut from the repository's default branch; elsewhere workers share the conversation's folder.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "../../config";

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { ok: (await proc.exited) === 0, out: (out + err).trim() };
}

export async function isRepository(directory: string): Promise<boolean> {
  return (await git(directory, ["rev-parse", "--is-inside-work-tree"])).out === "true";
}

export async function defaultBranch(directory: string): Promise<string> {
  const remote = await git(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.out.length > 0) return remote.out.replace(/^origin\//, "");
  const current = await git(directory, ["branch", "--show-current"]);
  return current.ok && current.out.length > 0 ? current.out : "HEAD";
}

export const slug = (branch: string): string => branch.replace(/[^A-Za-z0-9._-]+/g, "-");

/** The folder a branch's agent works in, created when missing. */
export async function workspaceFor(conversation: string, directory: string, branch: string): Promise<string> {
  if (!await isRepository(directory)) return directory;
  const path = paths.worktree(conversation, slug(branch));
  if (existsSync(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  const exists = (await git(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  const base = await defaultBranch(directory);
  const result = exists ? await git(directory, ["worktree", "add", path, branch]) : await git(directory, ["worktree", "add", "-b", branch, path, base]);
  if (!result.ok) throw new Error(`git worktree add failed: ${result.out}`);
  return path;
}

/** Remove a conversation's worktrees from Git's records (the folders go with deleteConversation). */
export async function pruneWorktrees(directory: string): Promise<void> {
  if (await isRepository(directory)) await git(directory, ["worktree", "prune"]);
}
