// tmux servers retain their startup environment. Hand each agent the current
// launch environment without exposing credentials in process arguments or tmux options.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";

// The window's own identity comes from where it opens, never from the launcher: tmux's, or Rex's (REX_SESSION and
// REX_BLOCK name the agent's own Rex session and block, which the launcher's would not; unset outside Rex).
const WINDOW_ENV = new Set(["TMUX", "TMUX_PANE", "REX_SESSION", "REX_BLOCK", "PWD", "OLDPWD", "SHLVL", "_"]);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const BOOTSTRAP = 'exec /usr/bin/env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" REX_SESSION="$REX_SESSION" REX_BLOCK="$REX_BLOCK" /bin/sh "$@"';
/** A Rex variable the window did not set is dropped rather than left empty. */
const UNSET_EMPTY = '[ -n "$REX_SESSION" ] || unset REX_SESSION; [ -n "$REX_BLOCK" ] || unset REX_BLOCK';

export async function launchEnvironment(project: string, command: string[], env = process.env): Promise<{ argv: string[]; cleanup: () => Promise<void> }> {
  const root = join(paths.project(project), "launches");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "env-"));
  const file = join(directory, "launch.sh");
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const exports = Object.entries(env).filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !WINDOW_ENV.has(key))
      .map(([key, value]) => `export ${key}=${quote(value!)}`);
    await writeFile(file, [...exports, UNSET_EMPTY, '/bin/rm -f -- "$0" || exit 1', '/bin/rmdir -- "$1" || exit 1', 'shift', 'exec "$@"', ""].join("\n"), { mode: 0o600, flag: "wx" });
    return { argv: ["/bin/sh", "-c", BOOTSTRAP, "sh", file, directory, ...command], cleanup };
  } catch (error) { await cleanup(); throw error; }
}
