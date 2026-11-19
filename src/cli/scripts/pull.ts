import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pullHarness } from "../../core/install";
import { pastel } from "../../tui/components";

/** `orca pull`: update the installed checkout and binary, then hand running orchestrators over to the new build.
 * One line says what happened: the commit moved, it was already up to date, or the pull failed (the old binary stays). */
type Output = { write: (text: string) => unknown; isTTY: boolean | undefined };

export async function pull(out: Output = process.stdout, err: Output = process.stderr, colour = !!process.stdout.isTTY && !process.env.NO_COLOR, update = pullHarness): Promise<void> {
  const style = (code: string) => (text: string) => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = style("2"), bold = style("1"), green = style(pastel.green), red = style(pastel.red);
  const short = (sha: string) => sha.slice(0, 7);
  if (out.isTTY) out.write(dim("pulling orca…"));
  const clear = () => { if (out.isTTY) out.write("\r\x1b[2K"); };
  let result: Awaited<ReturnType<typeof pullHarness>>;
  try { result = await update({ write: () => {} }); }
  catch (error) {
    clear();
    err.write(`${red("✗")} orca pull failed: ${error instanceof Error ? error.message : String(error)}\n${dim("  the installed orca was not replaced")}\n`);
    process.exitCode = 1;
    return;
  }
  clear();
  out.write((result.from === result.to ? `${green("✓")} orca ${bold(short(result.to))} ${dim("is already up to date")}` : `${green("✓")} orca ${dim(short(result.from) + " →")} ${bold(short(result.to))}`) + "\n");
  try { reload(result.binary); }
  catch (error) { err.write(`${red("✗")} the reload did not start: ${error instanceof Error ? error.message : error}; run orca pull again\n`); }
}

/** The reload runs in the NEW binary (the internal `reload` command) and must outlive this terminal.
 * A global pull always targets ~/.orca, whatever ORCA_HOME says. Its log holds build and project ids, never credentials. */
function reload(binary: string): string {
  const home = join(homedir(), ".orca"), runtime = join(home, ".runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const path = join(runtime, "updates.log"), log = openSync(path, "a", 0o600);
  try {
    Bun.spawn([binary, "reload"], { cwd: home, env: { ...process.env, ORCA_HOME: home }, stdin: "ignore", stdout: log, stderr: log, detached: true }).unref();
    return path;
  } finally { closeSync(log); }
}
