// A conversation's stop barrier outlives every TUI, daemon and worker process.
// Pi's session abort owns the run, retries and compaction together. Orca extends
// that lifetime across processes with a persistent generation barrier:
// https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/agent-session.ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../../config";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "../state";

const file = (project: string, name: string) => join(paths.runtimeProject(project), name);
function read(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function publish(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export const epoch = (project: string): string => read(file(project, "input-epoch")) ?? "";
export function advance(project: string): string {
  const value = crypto.randomUUID(); publish(file(project, "input-epoch"), value); return value;
}
export function stopped(project: string): boolean {
  const value = read(file(project, "execution-stop.json"));
  if (value === undefined) return false;
  const marker = JSON.parse(value) as { identity: string; epoch: string };
  if (typeof marker.identity !== "string" || typeof marker.epoch !== "string") throw new Error("invalid execution stop barrier");
  return marker.identity === projectIdentity(project);
}
export const stale = (project: string, admitted: string): boolean => stopped(project) || epoch(project) !== admitted;
export function assertActive(project: string, admitted = epoch(project)): void {
  if (stale(project, admitted)) throw new Error("conversation stopped; send a new message to resume");
}
export function stop(project: string): Promise<void> {
  const identity = projectIdentity(project);
  return withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity, "stopping execution");
    const generation = advance(project);
    publish(file(project, "execution-stop.json"), JSON.stringify({ identity, epoch: generation }));
  });
}
/** Only fresh human input, under the same project lock as stop and inbox publication. */
export function resume(project: string, submitted: string): void {
  if (submitted === epoch(project) && stopped(project)) rmSync(file(project, "execution-stop.json"));
}
