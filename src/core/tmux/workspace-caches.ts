import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { projectIdentity, workspaces } from "../data/projects";

export const bazelRoots = () => [join(homedir(), "Library", "Caches", "bazel", `_bazel_${userInfo().username}`), join(homedir(), ".cache", "bazel", `_bazel_${userInfo().username}`)];
/** Exact Bazel output-base workspace metadata, not names or timestamps. Shared
 * download/install caches and unknown/removed source directories are untouched. */
export async function discoverBuildCaches(roots = bazelRoots(), project?: string) {
  const issues: { path: string; disposition: string; session?: string }[] = [];
  const sessions = workspaces.list().filter(w => !w.cleanedAt && (!project || w.members.some(m => m.project === project)));
  if (!sessions.length) return issues;
  for (const root of roots) {
    let names: string[];
    try {
      if (!existsSync(root) || realpathSync(root) !== root) continue;
      names = await readdir(root);
    } catch (error) { issues.push({ path: root, disposition: `kept: build cache inspection failed (${error})` }); continue; }
    for (const name of names) {
      if (!/^[a-f0-9]{32}$/.test(name)) continue;
      const path = join(root, name);
      try {
        if (realpathSync(path) !== path) continue;
        const file = Bun.file(join(path, "DO_NOT_BUILD_HERE"));
        if (!await file.exists() || file.size > 8192) continue;
        const source = (await file.text()).trim();
        const owner = sessions.find(w => w.path === source);
        if (!owner || !existsSync(source) || workspaces.fingerprint(source) !== owner.fingerprint) continue;
        for (const m of owner.members) {
          // Deleted or recreated conversations retain their old ownership records.
          // Do not resolve resources through a missing identity or adopt them into its replacement.
          if (!existsSync(paths.project(m.project)) || projectIdentity(m.project) !== m.identity) {
            issues.push({ path, session: owner.id, disposition: `kept: build cache owner ${m.project} was removed or changed identity` });
            continue;
          }
          if (!workspaces.resource(m.project, "cache", path)) workspaces.own(m.project, "cache", path, { session: owner, path });
        }
      } catch (error) { issues.push({ path, disposition: `kept: build cache inspection failed (${error})` }); }
    }
  }
  return issues;
}
export async function cacheBlocker(r: workspaces.Resource): Promise<string | undefined> {
  if (!r.path || !existsSync(r.path)) return;
  if (workspaces.fingerprint(r.path) !== r.fingerprint) return "build cache identity changed";
  const source = (await Bun.file(join(r.path, "DO_NOT_BUILD_HERE")).text()).trim();
  if (!r.owners.some(id => workspaces.get(id)?.path === source)) return "build cache workspace changed";
  const server = Bun.file(join(r.path, "server", "server.pid.txt"));
  if (!await server.exists()) return;
  const pid = Number((await server.text()).trim());
  if (!Number.isSafeInteger(pid) || pid < 1) return "cannot verify build server PID";
  try { process.kill(pid, 0); return "build server is still present"; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return "cannot inspect build server"; }
}
