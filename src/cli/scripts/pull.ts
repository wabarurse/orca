import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pullHarness } from "../../core/install";

/** `orca pull`: update the installed checkout and binary, then hand running orchestrators over to the new build. */
export async function pull(): Promise<void> {
  let binary: string;
  try { binary = await pullHarness(); }
  catch (error) {
    console.error(`orca pull: ${error instanceof Error ? error.message : String(error)}\nthe installed executable was not replaced on failure; the harness checkout/dependencies may have advanced. inspect the error and retry after resolving it.`);
    process.exitCode = 1;
    return;
  }
  try { console.log(`orchestrators reload after their current turns finish; progress: ${reload(binary)}. Reopen existing TUIs for the new interface.`); }
  catch (error) { console.error(`installation succeeded, but the reload did not start: ${error instanceof Error ? error.message : error}; run orca pull again`); }
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
