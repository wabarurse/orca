import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage, fail, ok, type Result } from "../../config";
import { pullHarness, type Pulled } from "../../core/install";
import { pastel } from "../../tui/components";

type Output = { write: (text: string) => unknown; isTTY: boolean };
type Update = () => Promise<Result<Pulled>>;
type Reload = (binary: string) => Result<string>;

export async function pull(out: Output, err: Output, colour: boolean, update: Update = () => pullHarness(), reload: Reload = startReload): Promise<number> {
  const style = (code: string) => (text: string): string => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = style("2"), bold = style("1"), green = style(pastel.green), red = style(pastel.red);
  const short = (sha: string): string => sha.slice(0, 7);
  if (out.isTTY) out.write(dim("pulling orca2…"));
  const clear = (): void => { if (out.isTTY) out.write("\r\x1b[2K"); };
  const result = await update().catch((error: unknown) => fail(errorMessage(error)));
  clear();
  if (!result.ok) {
    err.write(`${red("✗")} orca2 pull failed: ${result.error}\n${dim("  the installed orca2 was not replaced")}\n`);
    return 1;
  }
  const { from, to, binary } = result.data;
  out.write(`${from === to ? `${green("✓")} orca2 ${bold(short(to))} ${dim("is already up to date")}` : `${green("✓")} orca2 ${dim(`${short(from)} →`)} ${bold(short(to))}`}\n`);
  const reloaded = reload(binary);
  if (!reloaded.ok) err.write(`${red("✗")} the reload did not start: ${reloaded.error}; run orca2 pull again\n`);
  return 0;
}

function startReload(binary: string): Result<string> {
  const home = join(homedir(), ".orca2"), runtime = join(home, ".runtime");
  try {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const path = join(runtime, "updates.log"), log = openSync(path, "a", 0o600);
    try {
      Bun.spawn([binary, "reload"], { cwd: home, env: { ...process.env, ORCA2_HOME: home }, stdin: "ignore", stdout: log, stderr: log, detached: true }).unref();
      return ok(path);
    } finally { closeSync(log); }
  } catch (error) { return fail(errorMessage(error)); }
}
