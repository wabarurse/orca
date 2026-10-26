import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "../../../config/config";
import { deleteProject } from "../../../tui/commands/commands";
import { projectIdentity, withProjectStateLock } from "./state";
import { effectiveModel, saveProjectModel } from "./project-model";

const home = mkdtempSync(join(tmpdir(), "project-state-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("save captures directory generation before queue wait, rejects delete/recreate", async () => {
  const project = "recreated";
  mkdirSync(paths.project(project), { recursive: true });
  const oldIdentity = projectIdentity(project);
  const entered = deferred();
  const release = deferred();
  const deleting = withProjectStateLock(project, async () => {
    entered.resolve(); await release.promise;
    rmSync(paths.project(project), { recursive: true });
    mkdirSync(paths.project(project));
  });
  await entered.promise;
  const save = saveProjectModel(project, "claude-stale", oldIdentity);
  const rejection = save.catch((error: Error) => error);
  release.resolve(); await deleting;
  expect(await rejection).toBeInstanceOf(Error);
  expect(String(await rejection)).toContain("project changed");
  expect(await Bun.file(join(paths.project(project), "model")).exists()).toBe(false);
});

test("managed deletion and saves share lock: queued save cannot resurrect deleted project", async () => {
  const project = "deleted";
  await saveConfig({ model: "gpt-global" });
  mkdirSync(paths.project(project), { recursive: true });
  const entered = deferred();
  const release = deferred();
  const blocked = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const ready = deferred();
  const deletion = deleteProject(project, { live: async () => [], kill: async () => { ready.resolve(); } });
  await ready.promise;
  // Let deleteProject reserve the shared lock before invoking save.
  await Bun.sleep(0);
  const save = saveProjectModel(project, "claude-stale");
  const rejection = save.catch((error: Error) => error);
  release.resolve(); await blocked; await deletion;
  expect(await rejection).toBeInstanceOf(Error);
  expect(await effectiveModel(project)).toBe("gpt-global");
  expect(await Bun.file(join(paths.project(project), "model")).exists()).toBe(false);
});

test("invocation queue prevents overlapping writes from reversing final model", async () => {
  const project = "ordered";
  mkdirSync(paths.project(project), { recursive: true });
  const entered = deferred();
  const release = deferred();
  const blocked = withProjectStateLock(project, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const first = saveProjectModel(project, "claude-first");
  const second = saveProjectModel(project, "gpt-second");
  release.resolve(); await blocked; await Promise.all([second, first]);
  expect(await effectiveModel(project)).toBe("gpt-second");
});
