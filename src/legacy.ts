// Read compatibility only. New names and records use orca; do not rewrite saved data.
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const legacy = {
  stateDirectory: ".parallels",
  homeVariable: "PARALLELS_HOME",
  worktreeSuffix: ".parallels-worktrees",
  imagePrefix: "parallels-image:",
  executable: "parallels",
  engine: "parallels",
} as const;

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Never migrate live storage. An explicit override wins, then existing state. */
export function stateRoot(home: string, env: NodeJS.ProcessEnv): string {
  if (env.ORCA_HOME !== undefined) return env.ORCA_HOME;
  if (env[legacy.homeVariable] !== undefined) return env[legacy.homeVariable]!;
  const old = join(home, legacy.stateDirectory), current = join(home, ".orca");
  // The new installer can create .orca/app before the old state is migrated.
  // A new app checkout alone must not hide existing accounts or conversations.
  const currentState = ["config.toml", "auth", "projects"].some(name => present(join(current, name)));
  return !currentState && present(old) ? old : current;
}

/** Existing worktrees keep their Git-registered location. */
export function worktreeRoot(checkout: string, id: string): string {
  const old = join(`${checkout}${legacy.worktreeSuffix}`, id);
  return present(old) ? old : join(`${checkout}.orca-worktrees`, id);
}

/** Updates use an installed checkout, independently of the runtime state root. */
export function installedApp(home: string): string {
  const current = join(home, ".orca", "app");
  return present(current) ? current : join(home, legacy.stateDirectory, "app");
}

export const harnessEngine = (engine: unknown) => engine === "orca" || engine === legacy.engine;
