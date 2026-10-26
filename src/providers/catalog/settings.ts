// What a request may carry per model: effort level and fast mode, validated
// against the endpoint's capability list before a provider sends them.

import { knownEfforts, modelCapabilities, type Effort } from "./capabilities";

export interface RequestSettings { effort?: Effort; fast?: boolean }
function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate the stored shape before merging, so a reset cannot silently repair
 * corrupt data. Capability validation is separate: default/off may reset a
 * well-shaped preference that the current capability snapshot no longer supports. */
export function assertSettingsShape(value: unknown): asserts value is RequestSettings {
  if (!isRecord(value)) throw new Error("invalid project model settings: expected a record");
  const entry = value as Record<string, unknown>;
  const unexpected = Object.keys(entry).filter((key) => key !== "effort" && key !== "fast");
  if (unexpected.length) throw new Error(`invalid project model settings: unexpected keys: ${unexpected.join(", ")}`);
  if (entry.effort !== undefined && typeof entry.effort !== "string") throw new Error("invalid effort: expected a string");
  if (entry.fast !== undefined && typeof entry.fast !== "boolean") throw new Error("invalid fast mode: expected a boolean");
}
/** Shape, effort and fast checks. Saves validate effort against the current list
 * (`modelCapabilities`); providers use the default, every level known from the table or
 * the catalog, so a request resolved moments before the catalog landed is never refused here. */
export function validateSettings(model: string, settings: RequestSettings, efforts: Effort[] = knownEfforts(model)): void {
  assertSettingsShape(settings);
  const supported = modelCapabilities(model);
  if (settings.effort !== undefined && !efforts.includes(settings.effort)) throw new Error(`effort ${settings.effort} is unsupported for ${model}; supported: default, ${supported.effort.join(", ") || "no explicit levels"}`);
  if (settings.fast !== undefined && typeof settings.fast !== "boolean") throw new Error("invalid fast mode");
  if (settings.fast && !supported.fast) throw new Error(`fast mode is unsupported for ${model} on this endpoint`);
}
