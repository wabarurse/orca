import { mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, fail, ok, paths, type Result } from "../../config";
import type { Launch } from "../plugins/types";

export type Answer = { code: number; out: string; err: string };

export const which = (name: string): string | null => Bun.which(name, { PATH: process.env.PATH ?? "" });

export async function exec(argv: string[], timeoutMs = 10_000): Promise<Result<Answer>> {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    const proc = Bun.spawn(argv, { cwd: paths.root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return proc.signalCode === null ? ok({ code, out, err }) : fail(`${argv[0] ?? "command"} was stopped by ${proc.signalCode}`);
  } catch (error) {
    return fail(errorMessage(error));
  }
}

const WINDOW_ENV = ["TMUX", "TMUX_PANE", "REX_SESSION", "REX_BLOCK"];
const SKIP = new Set([...WINDOW_ENV, "PWD", "OLDPWD", "SHLVL", "_"]);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const BOOTSTRAP = `exec /usr/bin/env -i ${WINDOW_ENV.map(k => `${k}="$${k}"`).join(" ")} /bin/sh "$@"`;

export type LaunchCommand = { argv: string[]; cleanup: () => Promise<void> };

export async function launchCommand(launch: Launch): Promise<LaunchCommand> {
  const dir = join(paths.runtime, "launches");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${crypto.randomUUID()}.sh`);
  const exports = Object.entries(launch.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !SKIP.has(key)).map(([key, value]) => `export ${key}=${quote(value)}`);
  const unsetEmpty = WINDOW_ENV.map(k => `[ -n "$${k}" ] || unset ${k}`);
  const run = ['/bin/rm -f -- "$0"', 'LOG=$1', "shift", '"$@" 2>&1 | /usr/bin/tee -a "$LOG"'];
  await writeFile(file, [...exports, ...unsetEmpty, ...run, ""].join("\n"), { mode: 0o600, flag: "wx" });
  return { argv: ["/bin/sh", "-c", BOOTSTRAP, "sh", file, launch.log, ...launch.argv], cleanup: () => rm(file, { force: true }) };
}
