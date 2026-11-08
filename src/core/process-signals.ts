/** A shell and its ordinary descendants share a detached process group. */
export function killGroup(proc: { pid: number; kill(signal: "SIGKILL"): unknown }): string[] {
  const errors: string[] = [];
  try { process.kill(-proc.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`process group ${proc.pid}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    try { proc.kill("SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`process ${proc.pid}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }
  }
  return errors;
}

