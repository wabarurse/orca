import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../proc";

/** Bun may leave extracted executables beside the compiled app. Only old,
 * owned regular files with no observable open handles are disposable. */
export async function pruneBuildScratch(app: string, apply = false) {
  const changes: { path: string; disposition: string }[] = [];
  for (const name of await readdir(app).catch(() => [] as string[])) {
    if (!/^\.[a-f0-9]+-[a-f0-9]+\.bun-build$/.test(name)) continue;
    const path = join(app, name), st = await lstat(path);
    if (!st.isFile() || st.uid !== process.getuid?.() || Date.now() - st.mtimeMs < 86400_000) continue;
    const users = await run(["lsof", "-t", "--", path], { cwd: app, timeoutMs: 5000 });
    if (!users || users.code !== 1 || users.out.trim() || users.err.trim()) continue;
    if (apply) await rm(path);
    changes.push({ path, disposition: apply ? "removed unused Bun scratch" : "eligible: unused Bun scratch older than one day" });
  }
  return changes;
}
