// usage.jsonl: one line per model call, tool call and command, for diagnosis after the fact.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./paths";

/** Append-only accounting: no prompts, command text, credentials or provider error bodies. */
export async function usageEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    await appendFile(join(paths.runtime, "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch { console.warn("orca: usage recording unavailable; execution continues"); }
}
