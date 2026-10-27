import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const existsSync = (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };

export const movedRoot = ["app", "checkout-locks", "turn-locks", "project-locks", "daemon-locks"];
export const movedProject = ["orchestrator", "inbox", "runs", "questions", "merged"];
export const runtimeRoot = (root: string) => join(root, ".runtime");
export function legacyEntries(root: string): string[] {
  const entries = [...movedRoot, "tmux.sock"].filter(n => existsSync(join(root, n)));
  if (existsSync(join(root, "projects"))) for (const p of readdirSync(join(root, "projects"))) {
    for (const n of movedProject) if (existsSync(join(root, "projects", p, n))) entries.push(join("projects", p, n));
  }
  return entries;
}
/** CLI entry gate, before launching agents or mutating any project. No migration here. */
export function assertLayout(root: string): void {
  const runtime = runtimeRoot(root), journal = join(runtime, "migration.json");
  for (const dir of [root, runtime]) if (existsSync(dir)) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe layout directory: ${dir}`);
  }
  for (const file of [journal, join(runtime, "layout.json"), join(runtime, "activated")]) if (existsSync(file)) {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error(`unsafe layout marker: ${file}`);
  }
  const fail = () => { throw new Error("Orca layout needs manual offline migration/recovery. Stop all participants and prevent old launches; see docs/ORCA_HOME.md and scripts/migrate-layout.ts. No automatic migration was performed."); };
  if (existsSync(journal)) {
    try { if (JSON.parse(readFileSync(journal, "utf8")).phase !== "complete") fail(); } catch { fail(); }
  }
  if (legacyEntries(root).length) fail();
  const marker = join(runtime, "layout.json");
  if (existsSync(marker)) {
    if (JSON.parse(readFileSync(marker, "utf8")).version !== 2) fail();
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
