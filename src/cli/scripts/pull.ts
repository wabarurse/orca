import { pullHarness } from "../../core/install";
import { activateInstalled } from "./reload";

/** `orca pull`: update the installed checkout and binary, then hand running daemons over to the new build. */
export async function pull(): Promise<void> {
  try { await activateInstalled(await pullHarness()); }
  catch (error) {
    console.error(`orca pull: ${error instanceof Error ? error.message : String(error)}\nthe installed executable was not replaced on failure; the harness checkout/dependencies may have advanced. inspect the error and retry after resolving it.`);
    process.exitCode = 1;
  }
}
