import { readProjectState, writeProjectState } from "../../../config";
import { modelCapabilities, type Effort } from "../../../providers/catalog";
import { assertSettingsShape, validateSettings, type RequestSettings } from "../../../providers/catalog";
import { effectiveModel } from "./project-model";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./state";

type SavedSettings = Record<string, unknown>;
async function readSettings(project: string): Promise<SavedSettings> {
  const saved = readProjectState<SavedSettings>(project, "model-settings");
  const value = saved === undefined ? {} : saved;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project model settings");
  return value;
}
function selectedSettings(saved: SavedSettings, model: string): RequestSettings {
  const entry = Object.hasOwn(saved, model) ? saved[model] : {};
  assertSettingsShape(entry);
  return entry;
}
export interface SettingsReport { settings: RequestSettings; /** A saved effort the current capability list does not include: omitted, not an error. */ dropped?: Effort }
/** The saved preference as a request may carry it. Capabilities vary over time (catalog
 * fetch) and per process, so an effort the current list lacks is dropped to the backend
 * default and reported, never thrown: an agent mid-run keeps working. The saved value stays
 * on disk and applies again wherever the list includes it. Malformed data still throws. */
export async function effectiveSettingsReport(project: string, model: string): Promise<SettingsReport> {
  const report = withSupportedEffort(await readSettings(project), model);
  validateSettings(model, report.settings); // shape and fast; an unsupported saved fast mode is still an error
  return report;
}
/** The saved entry (shape-checked) with an effort the current list lacks moved to `dropped`. */
function withSupportedEffort(saved: SavedSettings, model: string): SettingsReport {
  const { effort, ...rest } = selectedSettings(saved, model);
  if (effort !== undefined && !modelCapabilities(model).effort.includes(effort)) return { settings: rest, dropped: effort };
  return { settings: effort === undefined ? rest : { ...rest, effort } };
}
export async function effectiveSettings(project: string, model: string): Promise<RequestSettings> {
  return (await effectiveSettingsReport(project, model)).settings;
}
/** Per-model preferences prevent invalid effort/tier fields crossing providers.
 * Queue order starts at saveProjectSettings invocation, after any command reads. */
export function saveProjectSettings(project: string, model: string, patch: RequestSettings, expectedIdentity?: string): Promise<void> {
  try {
    validateSettings(model, patch, modelCapabilities(model).effort);
    const identity = expectedIdentity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitSettings(project, model, patch, identity));
  } catch (error) { return Promise.reject(error); }
}
async function commitSettings(project: string, model: string, patch: RequestSettings, identity: string): Promise<void> {
  assertProjectIdentity(project, identity, "saving settings");
  if (await effectiveModel(project) !== model) throw new Error("model changed while saving settings; try again");
  const saved = await readSettings(project);
  // Merge onto the effective settings: a saved effort the current list no longer includes is not carried along.
  const entry = { ...withSupportedEffort(saved, model).settings, ...patch };
  validateSettings(model, entry, modelCapabilities(model).effort);
  const next = { ...saved, [model]: entry };
  assertProjectIdentity(project, identity, "saving settings");
  writeProjectState(project, "model-settings", next);
}
/** A validated /effort or /fast value for the project's model when the command ran; `save` writes exactly that model (it fails if the model changed meanwhile). */
export interface SettingChange { setting: "effort" | "fast"; model: string; value: string; save(): Promise<string> }
/** `/effort [arg]` / `/fast [arg]`: the report when `arg` is empty, otherwise the change, validated before anything is saved. */
export async function settingChange(project: string, setting: SettingChange["setting"], arg: string): Promise<string | SettingChange> {
  const identity = projectIdentity(project);
  const model = await effectiveModel(project);
  const current = arg ? undefined : await effectiveSettings(project, model);
  if (setting === "effort") {
    if (current) return `effort for ${model}: ${current.effort ?? "default (backend default)"}; supported: ${["default", ...modelCapabilities(model).effort].join(", ")}`;
    validateSettings(model, { effort: arg === "default" ? undefined : arg as Effort }, modelCapabilities(model).effort);
    return { setting, model, value: arg, save: () => setEffort(project, model, arg, identity) };
  }
  if (current) return `fast for ${model}: ${current.fast ? "on" : "off"}; ${modelCapabilities(model).fast ? "supported (premium usage/entitlement may apply)" : "on unsupported on this endpoint"}`;
  if (arg !== "on" && arg !== "off") throw new Error("usage: /fast [on|off]");
  validateSettings(model, { fast: arg === "on" });
  return { setting, model, value: arg, save: async () => {
    await saveProjectSettings(project, model, { fast: arg === "on" }, identity);
    return `fast for ${model}: ${arg}; ${SETTING_SEMANTICS}${arg === "on" ? "; premium usage/entitlement may apply" : ""}`;
  } };
}
export async function effortCommand(project: string, arg: string): Promise<string> {
  const change = await settingChange(project, "effort", arg);
  return typeof change === "string" ? change : change.save();
}
/** Saves effort for exactly `model` (it fails if the project's model changed meanwhile), so a picker opened for one model cannot write another's. */
export async function setEffort(project: string, model: string, arg: string, identity: string): Promise<string> {
  await saveProjectSettings(project, model, { effort: arg === "default" ? undefined : arg as Effort }, identity);
  return `effort for ${model}: ${arg}; ${SETTING_SEMANTICS}`;
}
export async function fastCommand(project: string, arg: string): Promise<string> {
  const change = await settingChange(project, "fast", arg);
  return typeof change === "string" ? change : change.save();
}
const SETTING_SEMANTICS = "saved for this project/model; applies before each agent’s next model request; running tools finish; failed/stopped turns need another message to resume; exited agents require restart";
