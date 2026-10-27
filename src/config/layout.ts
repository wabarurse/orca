import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { present as existsSync, safeDirectory, safeFile } from "./layout-safety";

export const movedRoot = ["app", "checkout-locks", "turn-locks", "project-locks", "daemon-locks"];
export const movedProject = ["orchestrator", "inbox", "runs", "questions", "merged"];
export const runtimeRoot = (root: string) => join(root, ".runtime");
export function legacyEntries(root: string): string[] {
  const entries = [...movedRoot, "tmux.sock"].filter(n => existsSync(join(root, n)));
  const projects = join(root, "projects");
  if (!existsSync(projects)) return entries;
  safeDirectory(projects);
  for (const p of readdirSync(projects)) {
    safeDirectory(join(projects, p));
    for (const n of movedProject) if (existsSync(join(projects, p, n))) entries.push(join("projects", p, n));
  }
  return entries;
}
/** CLI entry gate, before launching agents or mutating any project. No migration here. */
export function assertLayout(root: string): void {
  const runtime = runtimeRoot(root), journal = join(runtime, "migration.json");
  validateLayoutPaths(root, runtime, journal);
  if (existsSync(journal)) requireMarker(journal, "phase", "complete");
  if (legacyEntries(root).length) fail();
  const marker = join(runtime, "layout.json");
  if (existsSync(marker)) {
    requireMarker(marker, "version", 2);
  } else {
    // Existing state without a marker requires an explicit offline decision too.
    if (["projects", "memory.sqlite", "config.toml", "auth"].some(n => existsSync(join(root, n)))) fail();
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    writeFileSync(marker, JSON.stringify({ version: 2 }) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink()) fail();
  // Rollback is safe only before the new layout has been used.
  if (!existsSync(join(runtime, "activated"))) writeFileSync(join(runtime, "activated"), "2\n", { mode: 0o600, flag: "wx" });
}

function fail(): never {
  throw new Error("Orca layout needs manual offline migration/recovery. Stop all participants and prevent old launches; see docs/ORCA_HOME.md and scripts/migrate-layout.ts. No automatic migration was performed.");
}
function requireMarker(file: string, key: string, expected: unknown) {
  try { if (JSON.parse(readFileSync(file, "utf8"))[key] !== expected) fail(); }
  catch { fail(); }
}
function validateLayoutPaths(root: string, runtime: string, journal: string) {
  for (const dir of [root, runtime]) if (existsSync(dir)) safeDirectory(dir);
  for (const file of [journal, join(runtime, "layout.json"), join(runtime, "activated")]) if (existsSync(file)) safeFile(file);
}
