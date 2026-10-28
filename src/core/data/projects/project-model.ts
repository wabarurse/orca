import { effectiveSettings } from "./project-settings";
import type { RequestSettings } from "../../../providers/catalog";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./state";
// A project override never changes the default used by other projects.
import { loadConfig, readProjectState, writeProjectState } from "../../../config";
import { provider } from "../../../providers";
import { prefetchContextLimits } from "../../../providers/catalog";
import { providerFor, type Provider } from "../../../providers";

function validateProject(project: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(project) || project === "." || project === "..") throw new Error("invalid project id");
}
export function validateModel(model: string): void {
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) || model.length > 200) throw new Error("invalid model id");
}
export async function effectiveModel(project: string): Promise<string> {
  validateProject(project);
  const saved = readProjectState<string>(project, "model");
  const model = saved === undefined ? (await loadConfig()).model : saved;
  validateModel(model);
  return model;
}
export function saveProjectModel(project: string, model: string, identity?: string): Promise<void> {
  // Capture identity and reserve queue position synchronously, before any await.
  try {
    validateModel(model);
    validateProject(project);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitModel(project, model, expected));
  } catch (error) { return Promise.reject(error); }
}
async function commitModel(project: string, model: string, identity: string): Promise<void> {
  assertProjectIdentity(project, identity, "switching model");
  writeProjectState(project, "model", model);
}
/** Re-read just before each request, never during a tool or an in-flight call. */
export function projectModelResolver(project: string, load: typeof provider = provider): () => Promise<{ model: string; provider: Provider; settings: RequestSettings }> {
  return async () => {
    const model = await effectiveModel(project);
    try {
      const selected = await load(providerFor(model));
      prefetchContextLimits(selected); // Background only: the turn never waits on the catalog.
      return { model, provider: selected, settings: await effectiveSettings(project, model) };
    }
    catch (error) { throw new Error(`cannot load provider for project ${project} model ${model}: ${error instanceof Error ? error.message : error}`); }
  };
}
