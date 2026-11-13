// Worktrees an older build created beside the checkout keep their Git-registered location.
import { lstatSync } from "node:fs";
import { join } from "node:path";

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Where worktrees were created beside the checkout. Existing ones stay; nothing new is created here. */
export function siblingWorktreeRoots(checkout: string, id: string): string[] {
  return [join(`${checkout}.orca-worktrees`, id)].filter(present);
}

/** True for the folder older builds made beside a checkout to hold its worktree namespaces. */
export const siblingWorktreeFolder = (path: string) => path.endsWith(".orca-worktrees");
