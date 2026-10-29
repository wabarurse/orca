import { BUILD_ID } from "../../../config";
import type { DaemonStatus } from "../../../protocol";
import { liveStatus } from "./channel";

/** A newer UI must not claim settings took effect in an older loaded runtime.
 * Development sessions have no compiled identity and remain explicitly unverified. */
export async function requireCurrentDaemon(project: string, options: { build?: string; status?: typeof liveStatus } = {}): Promise<void> {
  const build = options.build ?? BUILD_ID;
  if (build === "development") return;
  const status: DaemonStatus | undefined = await (options.status ?? liveStatus)(project);
  if (status && status.build !== build) throw new Error(`${project}: session uses a different Orca build; run orca reload, then reopen this TUI with the installed orca. Active turns finish before reload; history is retained.`);
}
