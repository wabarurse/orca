// Explicit harness updates only. The caller's repository and ORCA_HOME are
// never selection inputs. Tests inject a command boundary, not a runtime override.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
import { owned, prepareArtifact, withInstallation } from "./installation";
import { withGitCredentials } from "./git-credentials";
import { installedApp, legacy } from "../../config";

export const HARNESS_ORIGIN = "https://github.com/wabarurse/parallels.git";
export interface CommandResult { code: number; out: string; err: string }
export type UpdateCommand = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

export const updateCommand: UpdateCommand = async (argv, cwd, env) => {
  // Git and build tools must not create paths our ownership checks reject under
  // a permissive caller umask. Restrict only the child, retaining stricter masks.
  // Pass argv as positional arguments: paths/credentials are never shell source.
  const mask = (process.umask() | 0o022).toString(8);
  const child = Bun.spawn(["/bin/sh", "-c", 'umask "$1" && shift && exec "$@"', "orca-update", mask, ...argv],
    { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
};

function updateEnvironment(app: string, home: string): NodeJS.ProcessEnv {
  // In particular ignore GIT_DIR/WORK_TREE/CONFIG_* inherited from a caller's
  // repository or shell. Global URL rewrites/hooks cannot redirect this update;
  // fetch separately restores only credential settings through withGitCredentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, HOME: home, PWD: app, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

async function directory(path: string) {
  if (!await owned(path, true)) throw new Error(`missing harness installation at ${path}; use the documented clone/install steps first`);
}

async function appDirectory(home: string): Promise<string> {
  const root = await realpath(home);
  await directory(root);
  const app = installedApp(root);
  await directory(dirname(dirname(app)));
  await directory(dirname(app));
  await directory(app);
  // An actual dedicated clone, not a linked worktree or symlink into a project.
  await directory(join(app, ".git"));
  // Git will write refs, reflogs, objects and pseudorefs. Do not follow a
  // nested symlink/hardlink out of this dedicated clone, including ignored files.
  await safeGitTree(join(app, ".git"));
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    if (await owned(join(app, ".git", name))) throw new Error(`shared/alternate git storage is not a dedicated clone: ${name}`);
  }
  return app;
}

async function safeGitTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    await owned(child, entry.isDirectory());
    if (entry.isDirectory()) await safeGitTree(child);
  }
}

async function safeBuildPaths(app: string): Promise<void> {
  await owned(join(app, "node_modules"), true);
  for (const name of ["package.json", "bun.lock", "bun.lockb", "bunfig.toml"]) await owned(join(app, name));
  await owned(join(app, "dist"), true);
  await owned(join(app, "dist", "orca"));
  await owned(join(app, "dist", legacy.executable));
}

async function noOperationInProgress(app: string) {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "sequencer", "index.lock", "HEAD.lock", "shallow.lock", "config.lock", "packed-refs.lock"]) {
    try { await lstat(join(app, ".git", name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error(`harness has an in-progress git operation (${name}); resolve it manually before pull`);
  }
}

function need(bin: string): string {
  const path = Bun.which(bin);
  if (!path) throw new Error(`orca pull requires ${bin} on PATH (bun >= 1.4.2 is needed for updates, not normal runtime)`);
  return path;
}

export interface PullOptions {
  home?: string;
  command?: UpdateCommand;
  write?: (text: string) => void;
}

export async function pullHarness(options: PullOptions = {}): Promise<string> {
  const home = options.home ?? homedir(), command = options.command ?? updateCommand, write = options.write ?? console.log;
  const app = await appDirectory(home), env = updateEnvironment(app, home);
  const git = need("git"), bun = need("bun");
  const gitArgs = [git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
  const askGit = (...args: string[]) => command([...gitArgs, ...args], app, env);
  async function checked(argv: string[], label: string, commandEnv = env): Promise<string> {
    const result = await command(argv, app, commandEnv);
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}): ${(result.err || result.out).trim()}`);
    return result.out.trim();
  }
  const checkedGit = (...args: string[]) => checked([...gitArgs, ...args], `git ${args[0]}`);
  async function identity() {
    if (await appDirectory(home) !== app) throw new Error("harness path changed during update");
    const top = await checkedGit("rev-parse", "--show-toplevel");
    const gitDir = await checkedGit("rev-parse", "--absolute-git-dir");
    const commonDir = await checkedGit("rev-parse", "--git-common-dir");
    if (await realpath(top) !== app || await realpath(gitDir) !== join(app, ".git") || await realpath(resolve(app, commonDir)) !== join(app, ".git")) {
      throw new Error("harness path is not its own dedicated clone; refusing update");
    }
    // Check raw AND effective URL (including local config insteadOf rewrites).
    const raw = await checkedGit("config", "--get-all", "remote.origin.url");
    const effective = await checkedGit("remote", "get-url", "--all", "origin");
    if (raw !== HARNESS_ORIGIN || effective !== HARNESS_ORIGIN) throw new Error(`unexpected harness origin; expected exactly ${HARNESS_ORIGIN}`);
  }
  async function clean() {
    await noOperationInProgress(app);
    if (await checkedGit("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) {
      throw new Error("harness checkout has dirty or untracked files; preserve/review them manually before pull (no automatic stash/reset/clean)");
    }
  }
  async function branch(): Promise<string> {
    const result = await askGit("symbolic-ref", "-q", "HEAD");
    if (result.code === 1) return "detached";
    if (result.code !== 0) throw new Error(`cannot determine harness branch: ${result.err.trim()}`);
    if (result.out.trim() !== "refs/heads/main") throw new Error(`harness is on branch ${result.out.trim()}; preserve its work and explicitly select main before pull`);
    return "main";
  }

  return withInstallation(home, true, async installation => {
    await identity();
    await clean();
    await safeBuildPaths(app);
    const beforeBranch = await branch(), before = await checkedGit("rev-parse", "HEAD");
    const version = await checked([bun, "--version"], "bun version check");
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/.exec(version);
    if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && (Number(match[2]) < 4 || Number(match[2]) === 4 && Number(match[3]) < 2))) {
      throw new Error("orca pull requires bun >= 1.4.2 on PATH");
    }
    write(`updating harness only: ${app}\nfetching verified origin/main…`);
    // Use the verified URL rather than remote-specific helper/refspec options.
    // No leading '+' (force), tags, pruning, submodules or auxiliary ref updates.
    await withGitCredentials(git, app, env, command, authenticated => checked([
      ...gitArgs, "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap=", HARNESS_ORIGIN, "refs/heads/main:refs/remotes/origin/main",
    ], "git fetch", authenticated));
    // Recheck after the network operation: never merge over a concurrent local edit.
    await identity();
    await clean();
    if (await branch() !== beforeBranch || await checkedGit("rev-parse", "HEAD") !== before) throw new Error("harness checkout changed during fetch; refusing update");
    const target = await checkedGit("rev-parse", "refs/remotes/origin/main");
    if ((await askGit("merge-base", "--is-ancestor", before, target)).code !== 0) {
      throw new Error("harness HEAD is not an ancestor of origin/main; cannot fast-forward. preserve local/review commits in a named branch and reconcile manually, or wait for an ancestry-preserving merge. no commits were discarded");
    }
    write(before === target ? "harness already at origin/main; rebuilding/reinstalling (also retries a previous failed build)…" : `fast-forwarding ${beforeBranch} to ${target}…`);
    await checkedGit("merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", target);
    // Check build output paths before any dependency/build scripts can write there.
    await safeBuildPaths(app);
    const artifact = await prepareArtifact(app);
    write("installing frozen dependencies…");
    await checked([bun, "install", "--frozen-lockfile"], "dependency installation");
    write("building harness…");
    await checked([bun, "run", "build"], "harness build");
    await identity();
    await clean();
    if (await branch() !== beforeBranch || await checkedGit("rev-parse", "HEAD") !== target) throw new Error("harness checkout changed during build; refusing installation");
    await installation.replace(artifact);
    write(`installed ${installation.target} from ${target}. scheduling global orchestrator updates next.`);
    return installation.target;
  });
}
