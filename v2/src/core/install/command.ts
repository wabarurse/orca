export type CommandResult = { code: number; out: string; err: string };
export type Env = Record<string, string | undefined>;
export type UpdateCommand = (argv: string[], cwd: string, env: Env) => Promise<CommandResult>;

export async function run(argv: string[], cwd: string, env: Env): Promise<CommandResult> {
  try {
    const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  } catch (error) { return { code: 127, out: "", err: error instanceof Error ? error.message : String(error) }; }
}

export const updateCommand: UpdateCommand = (argv, cwd, env) => {
  const mask = (process.umask() | 0o022).toString(8);
  return run(["/bin/sh", "-c", 'umask "$1" && shift && exec "$@"', "orca2-update", mask, ...argv], cwd, env);
};
