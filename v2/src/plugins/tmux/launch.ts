// What the tmux and rex runners share: running their CLI, and the window command that hands an agent its
// environment. Environment values may hold credentials, so they never go into argv or multiplexer options: they are
// written to a private (0600), self-deleting shell file the window sources first, under a clean `env -i`.
import { mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import type { Launch } from "../../core/plugins/types";

export type Answer = { code: number; out: string; err: string };

/** A program on the current PATH (Bun.which alone reads the PATH the process started with). */
export const which = (name: string): string | null => Bun.which(name, { PATH: process.env.PATH ?? "" });

/** Run a CLI from orca2's home (a server it starts never holds a cwd that may vanish); null when it cannot run. */
export async function exec(argv: string[], timeoutMs = 10_000): Promise<Answer | null> {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    const proc = Bun.spawn(argv, { cwd: paths.root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return proc.signalCode === null ? { code, out, err } : null;
  } catch { return null; }
}

/** The window's own identity comes from where it opens (its tmux pane, its Rex block), never from the launcher. */
const WINDOW_ENV = ["TMUX", "TMUX_PANE", "REX_SESSION", "REX_BLOCK"];
const SKIP = new Set([...WINDOW_ENV, "PWD", "OLDPWD", "SHLVL", "_"]);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const BOOTSTRAP = `exec /usr/bin/env -i ${WINDOW_ENV.map(k => `${k}="$${k}"`).join(" ")} /bin/sh "$@"`;

export type WindowCommand = { argv: string[]; cleanup: () => Promise<void> };

/**
 * The argv a window runs: a clean environment holding only the window's identity, then the env file (which deletes
 * itself), then `launch.argv` with its output shown in the window and appended to `launch.log`. `cleanup` removes the
 * file when the window never opened.
 */
export async function windowCommand(launch: Launch): Promise<WindowCommand> {
  const dir = join(paths.runtime, "launches");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${crypto.randomUUID()}.sh`);
  const exports = Object.entries(launch.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !SKIP.has(key)).map(([key, value]) => `export ${key}=${quote(value)}`);
  const unsetEmpty = WINDOW_ENV.map(k => `[ -n "$${k}" ] || unset ${k}`);
  const run = ['/bin/rm -f -- "$0"', 'LOG=$1', "shift", '"$@" 2>&1 | /usr/bin/tee -a "$LOG"'];
  await writeFile(file, [...exports, ...unsetEmpty, ...run, ""].join("\n"), { mode: 0o600, flag: "wx" });
  return { argv: ["/bin/sh", "-c", BOOTSTRAP, "sh", file, launch.log, ...launch.argv], cleanup: () => rm(file, { force: true }) };
}

/** The multiplexer session of a conversation. */
export const sessionName = (conversation: string): string => `orca2-${conversation}`;
