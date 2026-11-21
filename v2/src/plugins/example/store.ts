import { join } from "node:path";
import { z } from "zod";
import type { Result } from "../../core/plugins";

const PinSchema = z.object({ id: z.string(), text: z.string(), by: z.string(), at: z.string() });
const PinsSchema = z.array(PinSchema);

export type Pin = z.infer<typeof PinSchema>;
export async function readPins(dir: string): Promise<Result<Pin[]>> {
  const file = Bun.file(join(dir, "pins.json"));
  if (!await file.exists()) return { ok: true, data: [] };
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); }
  catch (error) { return { ok: false, error: `pins.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  const parsed = PinsSchema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: `pins.json is not a list of pins: ${parsed.error.message}` };
}

export async function shownPins(dir: Result<string>): Promise<Pin[]> {
  if (!dir.ok) return [];
  const read = await readPins(dir.data);
  return read.ok ? read.data : [];
}

export async function writePins(dir: string, pins: Pin[]): Promise<void> {
  await Bun.write(join(dir, "pins.json"), JSON.stringify(pins, null, 2));
}
