import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { paths } from "../../config";
import { workspaces, assertWorktree } from "../data/projects";
import { processDirectory, verificationPaths, readVerification } from "../data/processes";
import { purgeTasks } from "../data/tasks";
import { purgeAgent } from "../data/memory";
import { clearWorkingContext } from "../data/knowledge";
import { open } from "../data/transcripts";
import { run } from "../proc";

const names = (path: string) => readdir(path).catch(e => { if (e.code === "ENOENT") return []; throw e; });
const within = (root: string, path: string) => path !== root && !relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== "..";
/** Refuse redirected ancestors. rm removes links rather than following them,
 * but walking through a replaced parent would address somebody else's files. */
export function safeOwnedPath(root: string, path: string): void {
  if (!within(root, path)) throw new Error("resource escapes its owned storage directory");
  for (let p = dirname(path); p !== dirname(root); p = dirname(p)) {
    if (existsSync(p) && realpathSync(p) !== p) throw new Error("resource parent was redirected");
    if (p === root) break;
  }
}
export async function allocatedBytes(path: string): Promise<number> {
  const st = await lstat(path).catch(e => { if (e.code === "ENOENT") return; throw e; });
  if (!st) return 0;
  if (!st.isDirectory() || st.isSymbolicLink()) return st.blocks * 512;
  let sum = st.blocks * 512;
  for (const name of await readdir(path)) sum += await allocatedBytes(join(path, name));
  return sum;
}
function generated(path: string, root: string): boolean {
  if (/(^|\/)(node_modules|dist|build|coverage|\.venv|venv|\.next|\.turbo|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.import_linter_cache|\.complexipy_cache|__pycache__|\.bazel-output|bazel-[^/]+|DerivedData)(\/|$)/.test(path)) return true;
  if (/(^|\/)\.DS_Store$|\.tsbuildinfo$/.test(path)) return true;
  const target = path.split("/").indexOf("target");
  return target >= 0 && existsSync(join(root, ...path.split("/").slice(0, target), "Cargo.toml"));
}
export async function checkoutFiles(w: workspaces.Workspace): Promise<{ generated: string[]; blocker?: string }> {
  if (!w.disposable || !existsSync(w.path)) return { generated: [] };
  if (workspaces.fingerprint(w.path) !== w.fingerprint) throw new Error("workspace directory identity changed");
  const member = w.members[0];
  if (!member || !w.branch || !w.repo) throw new Error("worktree ownership is incomplete");
  await assertWorktree(member.project, w.path, w.branch);
  return inspectCheckout(w.path);
}
/** What a checkout holds beyond its commits: build output that can be regenerated, and (the
 * blocker) source edits, untracked files or ignored files nobody can regenerate, such as `.env`. */
export async function inspectCheckout(path: string): Promise<{ generated: string[]; blocker?: string }> {
  const ignored = await run(["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: path, timeoutMs: 15_000 });
  const status = await run(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: path, timeoutMs: 15_000 });
  if (!ignored || ignored.code !== 0 || !status || status.code !== 0) throw new Error("cannot inspect checkout files");
  const files = ignored.out.split("\0").filter(Boolean);
  const disposable = files.filter(f => generated(f, path)).map(f => join(path, f));
  return { generated: disposable, ...(status.out.trim() ? { blocker: "source edits or untracked files" }
    : files.some(f => !generated(f, path)) ? { blocker: "unrecognized ignored files" } : {}) };
}
export async function removeGenerated(w: workspaces.Workspace, files: string[]): Promise<void> {
  if (workspaces.fingerprint(w.path) !== w.fingerprint) throw new Error("workspace directory identity changed");
  for (const file of files) { safeOwnedPath(w.path, file.replace(/\/$/, "")); await rm(file, { recursive: true, force: true }); }
}
async function agentFiles(project: string, agent: string): Promise<string[]> {
  if (!/^(orchestrator|(worker|reviewer)(-[A-Za-z0-9._-]+)?)$/.test(agent)) throw new Error("invalid owned agent");
  const result = [join(paths.inbox(project), agent), join(paths.runtimeProject(project), "contexts", `${agent}.json`)];
  for (const [root, stem] of [[dirname(paths.transcript(project, agent)), `${agent}.jsonl`], [paths.runs(project), agent], [paths.cache(project), agent]] as const) {
    for (const name of await names(root)) if (name === stem || name.startsWith(`${stem}.`)) result.push(join(root, name));
  }
  return result;
}
export async function resourcePaths(r: workspaces.Resource): Promise<string[]> {
  if (r.kind === "agent") return agentFiles(r.project, r.key);
  if (r.kind === "question") {
    if (!/^[\w.-]+$/.test(r.key) || r.key.includes("..")) throw new Error("invalid owned question");
    return ["json", "closed", "answered"].map(ext => join(paths.questions(r.project), `${r.key}.${ext}`));
  }
  if (r.kind === "process") return [processDirectory(r.project, r.key)];
  if (r.kind === "sandbox") { const p = verificationPaths(r.project, r.key); return [p.root, p.evidence]; }
  if (r.kind === "image") {
    if (!/^[a-f0-9-]{36}$/.test(r.key)) throw new Error("invalid owned image");
    return ["png", "jpg", "gif", "webp"].map(ext => join(paths.project(r.project), "images", `${r.key}.${ext}`));
  }
  if (r.kind === "artifact" && r.path) { safeOwnedPath(join(paths.project(r.project), "tool-outputs"), r.path); return [r.path]; }
  if (r.kind === "cache" && r.path) return [r.path];
  return [];
}
async function imageBlocker(r: workspaces.Resource): Promise<string | undefined> {
  const dir = dirname(paths.transcript(r.project, "orchestrator"));
  for (const name of await names(dir)) if (name.endsWith(".jsonl") && (await Bun.file(join(dir, name)).text()).includes(r.key)) return "image is referenced by retained conversation history";
  for (const name of await names(join(paths.project(r.project), "images", "inputs"))) if (name.endsWith(".json") && (await Bun.file(join(paths.project(r.project), "images", "inputs", name)).text()).includes(r.key)) return "image is referenced by a saved input";
}
export async function removeResource(r: workspaces.Resource): Promise<string | undefined> {
  if (r.kind === "task") { await purgeTasks(r.project, [r.key]); return; }
  if (r.kind === "image") { const reason = await imageBlocker(r); if (reason) return reason; }
  if (r.kind === "sandbox") {
    const v = await readVerification(r.project, r.key).catch(e => { if (e.code === "ENOENT") return; throw e; });
    if (v && v.state !== "closed") return "sandbox cleanup has not completed";
  }
  if (r.kind === "agent") {
    if (r.key === "orchestrator") {
      await clearWorkingContext(r.project);
      const consumed = open(paths.transcript(r.project, r.key)).consumed?.().inputs ?? new Set<string>();
      for (const id of consumed) if (/^[a-f0-9-]{36}$/.test(id)) {
        const path = join(paths.project(r.project), "images", "inputs", `${id}.json`);
        safeOwnedPath(paths.project(r.project), path);
        await rm(path, { force: true });
      }
    }
    purgeAgent(r.project, r.key);
  }
  for (const path of await resourcePaths(r)) {
    if (r.kind === "cache") {
      if (existsSync(path) && (!r.fingerprint || workspaces.fingerprint(path) !== r.fingerprint)) return "build cache identity changed";
    } else safeOwnedPath(path.startsWith(paths.runtime + sep) ? paths.runtime : paths.project(r.project), path);
    await rm(path, { recursive: true, force: true });
  }
}

/** Keep what only this checkout holds before it is removed: tracked edits, untracked files and ignored files no build
 * regenerates (an `.env`) become one commit on a new branch `orca-saved/<branch>-<time>`, built in a private index so
 * the checkout, its branch and the user's index are untouched. Build output (node_modules, dist…) is left out.
 * Returns the branch. Throws, removing nothing, when git cannot save it. */
export async function saveUncommitted(path: string, why: string, now = new Date()): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "orca-save-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const git = async (args: string[], extra: Record<string, string> = {}) => {
      const out = await run(["git", ...args], { cwd: path, timeoutMs: 120_000, env: { ...env, ...extra } });
      if (!out || out.code !== 0) throw new Error(`could not save local changes in ${path} (git ${args[0]}): ${out?.err.trim().slice(-300) ?? "timed out"}`);
      return out.out.trim();
    };
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "detached");
    await git(["read-tree", head]);
    await git(["add", "-A"]);
    const ignored = (await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])).split("\0").filter(f => f && !generated(f, path));
    if (ignored.length) await git(["add", "-f", "--", ...ignored.map(f => f.replace(/\/$/, ""))]);
    const tree = await git(["write-tree"]);
    // The repository's own identity when it has one; a fixed one only so the save never fails for lack of it.
    const known = (await run(["git", "var", "GIT_COMMITTER_IDENT"], { cwd: path, timeoutMs: 15_000 }))?.code === 0;
    const who: Record<string, string> = known ? {} : { GIT_AUTHOR_NAME: "orca", GIT_AUTHOR_EMAIL: "orca@localhost", GIT_COMMITTER_NAME: "orca", GIT_COMMITTER_EMAIL: "orca@localhost" };
    const commit = await git(["commit-tree", tree, "-p", head, "-m", `orca: local changes saved before ${why}\n\nFrom ${path} on ${branch}.`], who);
    const name = `orca-saved/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
    await git(["update-ref", `refs/heads/${name}`, commit, ""]);
    return name;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
