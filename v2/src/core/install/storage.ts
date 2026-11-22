import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./command";

export type Change = { path: string; disposition: string };

export async function pruneBuildScratch(app: string, apply: boolean): Promise<Change[]> {
  const changes: Change[] = [];
  for (const name of await readdir(app).catch((): string[] => [])) {
    if (!/^\.[a-f0-9]+-[a-f0-9]+\.bun-build$/.test(name)) continue;
    const path = join(app, name), st = await lstat(path);
    if (!st.isFile() || st.uid !== process.getuid?.() || Date.now() - st.mtimeMs < 86_400_000) continue;
    const users = await run(["lsof", "-t", "--", path], app, process.env);
    if (users.code !== 1 || users.out.trim().length > 0 || users.err.trim().length > 0) continue;
    if (apply) await rm(path);
    changes.push({ path, disposition: apply ? "removed unused Bun scratch" : "eligible: unused Bun scratch older than one day" });
  }
  return changes;
}
