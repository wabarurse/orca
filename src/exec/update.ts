import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { paths, installedApp, legacy } from "../config";
import { cliCommand } from "../core/tmux";

/** The updater must outlive the invoking terminal. Output is append-only and
 * inspectable; it contains build/project identities, never credentials. */
export function scheduleReload(): string {
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const path = join(paths.runtime, "updates.log"), log = openSync(path, "a", 0o600);
  try {
    const child = Bun.spawn([...cliCommand(), "apply-update"], { cwd: paths.root, stdin: "ignore", stdout: log, stderr: log, detached: true });
    child.unref();
    return `global session update scheduled; active turns finish before their orchestrators reload. Progress: ${path}. Reopen existing TUIs for the new interface.`;
  } finally { closeSync(log); }
}

/** Run the NEW binary after installation commits. Neither cwd nor runtime
 * overrides redirect a global pull. Activation failure cannot undo installation. */
export async function activateInstalled(binary: string, options: {
  home?: string;
  run?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  write?: (text: string) => void;
} = {}): Promise<void> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ORCA_HOME: dirname(dirname(installedApp(options.home ?? homedir()))) };
    delete env[legacy.homeVariable];
    const run = options.run ?? (async (argv, env) => Bun.spawn(argv, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited);
    if (await run([binary, "reload"], env) !== 0) throw new Error("activation command failed");
  } catch (error) { (options.write ?? console.error)(`installation succeeded, but session activation failed: ${error instanceof Error ? error.message : error}; run orca reload to retry`); }
}
