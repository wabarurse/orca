// usage.jsonl: one line per model call and tool call, read by the metrics scripts.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "./paths";

/** Append-only accounting: no prompts, command text, credentials or provider error bodies. */
export async function usageEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(paths.usage), { recursive: true, mode: 0o700 });
    await appendFile(paths.usage, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  } catch { console.warn("orca2: usage recording unavailable; execution continues"); }
}
