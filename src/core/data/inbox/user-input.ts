// Submission ordering, not wall-clock/persistence ordering. The barrier is
// published synchronously so same-tick UI, CLI and question sends see it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { paths } from "../../../config";

export function inputEpoch(project: string): string {
  try { return readFileSync(`${paths.runtimeProject(project)}/input-epoch`, "utf8"); }
  catch { return ""; }
}
export function advanceInputEpoch(project: string): string {
  const epoch = crypto.randomUUID();
  mkdirSync(paths.runtimeProject(project), { recursive: true });
  const path = `${paths.runtimeProject(project)}/input-epoch`;
  const tmp = `${path}.${epoch}.tmp`;
  try { writeFileSync(tmp, epoch); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
  return epoch;
}
