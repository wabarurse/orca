// A project override never changes the default used by other projects.
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths } from "./config";
import { provider } from "./accounts";
import { providerFor, type Provider } from "./providers";

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
export async function saveProjectModel(project: string, model: string): Promise<void> {
  validateModel(model);
  const path = modelPath(project);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    // Existing project only: don't resurrect a page deleted during a picker.
    await Bun.write(temp, model + "\n", { createPath: false });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
/** Re-read just before each request, never during a tool or an in-flight call. */
export function projectModelResolver(project: string, load: typeof provider = provider): () => Promise<{ model: string; provider: Provider }> {
  return async () => {
    const model = await effectiveModel(project);
    try { return { model, provider: await load(providerFor(model)) }; }
    catch (error) { throw new Error(`Cannot load provider for project ${project} model ${model}: ${error instanceof Error ? error.message : error}`); }
  };
}
