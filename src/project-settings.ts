import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";
import { modelCapabilities, type Effort } from "./model-capabilities";
import { effectiveModel } from "./project-model";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";

export interface RequestSettings { effort?: Effort; fast?: boolean }
type SavedSettings = Record<string, unknown>;
function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const settingsPath = (project: string) => join(paths.project(project), "model-settings.json");
async function readSettings(project: string): Promise<SavedSettings> {
  try {
    const value: unknown = JSON.parse(await Bun.file(settingsPath(project)).text());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project model settings");
    return value as SavedSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
/** Validate the stored shape before merging, so a reset cannot silently repair
 * corrupt data. Capability validation is separate: default/off may reset a
 * well-shaped preference that the current capability snapshot no longer supports. */
function assertSettingsShape(value: unknown): asserts value is RequestSettings {
  if (!isRecord(value)) throw new Error("invalid project model settings: expected a record");
  const entry = value as Record<string, unknown>;
  const unexpected = Object.keys(entry).filter((key) => key !== "effort" && key !== "fast");
  if (unexpected.length) throw new Error(`invalid project model settings: unexpected keys: ${unexpected.join(", ")}`);
  if (entry.effort !== undefined && typeof entry.effort !== "string") throw new Error("invalid effort: expected a string");
  if (entry.fast !== undefined && typeof entry.fast !== "boolean") throw new Error("invalid fast mode: expected a boolean");
}
function selectedSettings(saved: SavedSettings, model: string): RequestSettings {
  const entry = Object.hasOwn(saved, model) ? saved[model] : {};
  assertSettingsShape(entry);
  return entry;
}
export function validateSettings(model: string, settings: RequestSettings): void {
  assertSettingsShape(settings);
  const supported = modelCapabilities(model);
  if (settings.effort !== undefined && !supported.effort.includes(settings.effort)) throw new Error(`effort ${settings.effort} is unsupported for ${model}; supported: default, ${supported.effort.join(", ") || "no explicit levels"}`);
  if (settings.fast !== undefined && typeof settings.fast !== "boolean") throw new Error("invalid fast mode");
  if (settings.fast && !supported.fast) throw new Error(`fast mode is unsupported for ${model} on this endpoint`);
}
export async function effectiveSettings(project: string, model: string): Promise<RequestSettings> {
  const saved = await readSettings(project);
  const settings = selectedSettings(saved, model);
  validateSettings(model, settings);
  return settings;
}
/** Per-model preferences prevent invalid effort/tier fields crossing providers.
 * Queue order starts at saveProjectSettings invocation, after any command reads. */
export function saveProjectSettings(project: string, model: string, patch: RequestSettings, expectedIdentity?: string): Promise<void> {
  try {
    validateSettings(model, patch);
    const identity = expectedIdentity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitSettings(project, model, patch, identity));
  } catch (error) { return Promise.reject(error); }
}
async function commitSettings(project: string, model: string, patch: RequestSettings, identity: string): Promise<void> {
  assertProjectIdentity(project, identity);
  if (await effectiveModel(project) !== model) throw new Error("model changed while saving settings; try again");
  const saved = await readSettings(project);
  const entry = { ...selectedSettings(saved, model), ...patch };
  validateSettings(model, entry);
  const next = { ...saved, [model]: entry };
  const path = settingsPath(project);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify(next) + "\n", { createPath: false });
    assertProjectIdentity(project, identity);
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function effortCommand(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  const model = await effectiveModel(project);
  if (!arg) {
    const current = await effectiveSettings(project, model);
    return `effort for ${model}: ${current.effort ?? "default (backend default)"}; supported: ${["default", ...modelCapabilities(model).effort].join(", ")}`;
  }
  return setEffort(project, model, arg, identity);
}
/** Saves effort for exactly `model` (it fails if the project's model changed meanwhile), so a picker opened for one model cannot write another's. */
export async function setEffort(project: string, model: string, arg: string, identity: string): Promise<string> {
  await saveProjectSettings(project, model, { effort: arg === "default" ? undefined : arg as Effort }, identity);
  return `effort for ${model}: ${arg}; ${SETTING_SEMANTICS}`;
}
export async function fastCommand(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  const model = await effectiveModel(project);
  if (!arg) return `fast for ${model}: ${(await effectiveSettings(project, model)).fast ? "on" : "off"}; ${modelCapabilities(model).fast ? "supported (premium usage/entitlement may apply)" : "on unsupported on this endpoint"}`;
  if (arg !== "on" && arg !== "off") throw new Error("usage: /fast [on|off]");
  await saveProjectSettings(project, model, { fast: arg === "on" }, identity);
  return `fast for ${model}: ${arg}; ${SETTING_SEMANTICS}${arg === "on" ? "; premium usage/entitlement may apply" : ""}`;
}
const SETTING_SEMANTICS = "saved for this project/model; applies before each agent’s next model request; running tools finish; failed/stopped turns need another message to resume; exited agents require restart";
