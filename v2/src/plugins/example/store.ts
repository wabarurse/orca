// Pins live in $ORCA_DATA/example/pins.json (conversation scope): a short list of notes the agents keep.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../../core/plugins";

export type Pin = { id: string; text: string; by: string; at: string };

export async function readPins(dir: string): Promise<Pin[]> {
  const file = Bun.file(join(dir, "pins.json"));
  return await file.exists() ? await file.json() as Pin[] : [];
}

export async function writePins(dir: string, pins: Pin[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "pins.json"), JSON.stringify(pins, null, 2));
}
