// Per-project task-flow settings: the review-round limit and the dynamic-dispatch
// switch. projects/<id>/settings.json overrides config.toml's maxReviewRounds and
// dynamicDispatch; a missing file or key keeps the global value, so existing
// installs behave as before. Same lock, identity and atomic-rename rules as the
// project model (project-model.ts).
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, MAX_REVIEW_ROUNDS, paths, validRounds, type Config } from "./config";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";

export interface FlowSettings { maxReviewRounds: number; dynamicDispatch: boolean }
/** What settings.json may hold: either key, each valid when present. */
export type FlowOverride = Partial<FlowSettings>;

export function flowSettingsPath(project: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw new Error("invalid project id");
  return join(paths.project(project), "settings.json");
}

/** Refuse anything but a record of the two known keys, so a save never repairs or carries along bad data. */
export function validateFlow(value: unknown): asserts value is FlowOverride {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project settings: expected a record");
  const entry = value as Record<string, unknown>;
  const unexpected = Object.keys(entry).filter((key) => key !== "maxReviewRounds" && key !== "dynamicDispatch");
  if (unexpected.length) throw new Error(`invalid project settings: unexpected keys: ${unexpected.join(", ")}`);
  if (entry.maxReviewRounds !== undefined && !validRounds(entry.maxReviewRounds)) throw new Error(`invalid review rounds: expected an integer from 0 to ${MAX_REVIEW_ROUNDS}`);
  if (entry.dynamicDispatch !== undefined && typeof entry.dynamicDispatch !== "boolean") throw new Error("invalid dynamic dispatch: expected a boolean");
}

/** The saved override, {} when there is none; malformed files fail closed, naming the file. */
async function readOverride(project: string): Promise<FlowOverride> {
  const path = flowSettingsPath(project);
  let raw: string;
  try { raw = await Bun.file(path).text(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    validateFlow(value);
    return value;
  } catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** The project's values: its override where saved, config.toml's otherwise (passed in when already loaded). */
export async function effectiveFlow(project: string, config?: Pick<Config, "maxReviewRounds" | "dynamicDispatch">): Promise<FlowSettings> {
  const override = await readOverride(project);
  const base = config ?? await loadConfig();
  return { maxReviewRounds: override.maxReviewRounds ?? base.maxReviewRounds, dynamicDispatch: override.dynamicDispatch ?? base.dynamicDispatch };
}

/** Merge a patch into the project's override under the project-state lock; other projects and config.toml are untouched. */
export function saveProjectFlow(project: string, patch: FlowOverride, identity?: string): Promise<void> {
  // Capture identity and reserve queue position synchronously, before any await.
  try {
    validateFlow(patch);
    flowSettingsPath(project);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitFlow(project, patch, expected));
  } catch (error) { return Promise.reject(error); }
}

async function commitFlow(project: string, patch: FlowOverride, identity: string): Promise<void> {
  assertProjectIdentity(project, identity, "saving project settings");
  const next = { ...(await readOverride(project)), ...patch };
  const path = flowSettingsPath(project);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify(next) + "\n", { createPath: false });
    assertProjectIdentity(project, identity, "saving project settings");
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
