import { effectiveSettings } from "./project-settings";
import type { RequestSettings } from "../../../providers/catalog";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./state";
// A project override never changes the default used by other projects.
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths } from "../../../config";
import { provider } from "../../../providers";
import { prefetchContextLimits } from "../../../providers/catalog";
import { providerFor, type Provider } from "../../../providers";

function modelPath(project: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(project) || project === "." || project === "..") throw new Error("invalid project id");
  return join(paths.project(project), "model");
}
export function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) || model.length > 200) throw new Error("invalid model id");
}
export async function effectiveModel(project: string): Promise<string> {
  let model: string;
  try { model = (await Bun.file(modelPath(project)).text()).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    model = (await loadConfig()).model;
  }
  validateModel(model);
  return model;
}
export function saveProjectModel(project: string, model: string, identity?: string): Promise<void> {
  // Capture identity and reserve queue position synchronously, before any await.
  try {
    validateModel(model);
    modelPath(project);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitModel(project, model, expected));
  } catch (error) { return Promise.reject(error); }
}
async function commitModel(project: string, model: string, identity: string): Promise<void> {
  assertProjectIdentity(project, identity, "switching model");
  const path = modelPath(project);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, model + "\n", { createPath: false });
    assertProjectIdentity(project, identity, "switching model");
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
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
