import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorCode, fail, ok, type Result } from "../../config";
import { updateCommand, type Env, type UpdateCommand } from "./command";
import { withGitCredentials } from "./git-credentials";
import { BINARY, owned, prepareArtifact, withInstallation } from "./installation";
import { pruneBuildScratch } from "./storage";

export const HARNESS_ORIGIN = "https://github.com/wabarurse/orca.git";
export const installedApp = (home: string): string => join(home, ".orca2", ".runtime", "app");
export const PACKAGE = "v2";

export type PullOptions = { home: string; command: UpdateCommand; write: (text: string) => void };
export type Pulled = { binary: string; from: string; to: string };

const defaults = (): PullOptions => ({ home: homedir(), command: updateCommand, write: () => {} });

function updateEnvironment(app: string, home: string): Env {
  const env: Env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, HOME: home, PWD: app, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

async function directory(path: string): Promise<Result<null>> {
  const found = await owned(path, true);
  if (!found.ok) return found;
  return found.data === null ? fail(`missing harness installation at ${path}; install it first with: curl -fsSL https://raw.githubusercontent.com/wabarurse/orca/main/v2/install.sh | sh`) : ok(null);
}

async function safeGitTree(path: string): Promise<Result<null>> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const found = await owned(child, entry.isDirectory());
    if (!found.ok) return found;
    if (entry.isDirectory()) {
      const nested = await safeGitTree(child);
      if (!nested.ok) return nested;
    }
  }
  return ok(null);
}

async function appDirectory(home: string): Promise<Result<string>> {
  const root = await realpath(home);
  const app = installedApp(root);
  for (const path of [root, dirname(dirname(app)), dirname(app), app, join(app, ".git")]) {
    const found = await directory(path);
    if (!found.ok) return found;
  }
  const tree = await safeGitTree(join(app, ".git"));
  if (!tree.ok) return tree;
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    const found = await owned(join(app, ".git", name), false);
    if (!found.ok) return found;
    if (found.data !== null) return fail(`shared/alternate git storage is not a dedicated clone: ${name}`);
  }
  return ok(app);
}

async function safeBuildPaths(pkg: string): Promise<Result<null>> {
  const checks: [string, boolean][] = [[join(pkg, "node_modules"), true], [join(pkg, "package.json"), false], [join(pkg, "bun.lock"), false], [join(pkg, "bunfig.toml"), false], [join(pkg, "dist"), true], [join(pkg, "dist", BINARY), false]];
  for (const [path, dir] of checks) {
    const found = await owned(path, dir);
    if (!found.ok) return found;
  }
  return ok(null);
}

async function noOperationInProgress(app: string): Promise<Result<null>> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG", "sequencer", "index.lock", "HEAD.lock", "shallow.lock", "config.lock", "packed-refs.lock"]) {
    try { await lstat(join(app, ".git", name)); } catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
    return fail(`harness has an in-progress git operation (${name}); resolve it manually before pull`);
  }
  return ok(null);
}

function need(bin: string): Result<string> {
  const path = Bun.which(bin);
  return path === null ? fail(`orca2 pull requires ${bin} on PATH (bun >= 1.4.2 is needed for updates, not normal runtime)`) : ok(path);
}

const bunTooOld = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return true;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major < 1 || (major === 1 && (minor < 4 || (minor === 4 && patch < 2)));
};

export async function pullHarness(options: Partial<PullOptions> = {}): Promise<Result<Pulled>> {
  const { home, command, write } = { ...defaults(), ...options };
  const located = await appDirectory(home);
  if (!located.ok) return located;
  const app = located.data, pkg = join(app, PACKAGE), env = updateEnvironment(app, home);
  const gitPath = need("git"), bunPath = need("bun");
  if (!gitPath.ok) return gitPath;
  if (!bunPath.ok) return bunPath;
  const git = gitPath.data, bun = bunPath.data;
  const gitArgs = [git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
  const checked = async (argv: string[], label: string, cwd = app, commandEnv = env): Promise<Result<string>> => {
    const result = await command(argv, cwd, commandEnv);
    return result.code === 0 ? ok(result.out.trim()) : fail(`${label} failed (exit ${result.code}): ${(result.err.trim().length > 0 ? result.err : result.out).trim()}`);
  };
  const checkedGit = (...args: string[]): Promise<Result<string>> => checked([...gitArgs, ...args], `git ${args[0] ?? ""}`);

  const identity = async (): Promise<Result<null>> => {
    const again = await appDirectory(home);
    if (!again.ok) return again;
    if (again.data !== app) return fail("harness path changed during update");
    const top = await checkedGit("rev-parse", "--show-toplevel"), gitDir = await checkedGit("rev-parse", "--absolute-git-dir"), common = await checkedGit("rev-parse", "--git-common-dir");
    if (!top.ok) return top;
    if (!gitDir.ok) return gitDir;
    if (!common.ok) return common;
    if (await realpath(top.data) !== app || await realpath(gitDir.data) !== join(app, ".git") || await realpath(resolve(app, common.data)) !== join(app, ".git")) {
      return fail("harness path is not its own dedicated clone; refusing update");
    }
    const raw = await checkedGit("config", "--get-all", "remote.origin.url"), effective = await checkedGit("remote", "get-url", "--all", "origin");
    if (!raw.ok) return raw;
    if (!effective.ok) return effective;
    return raw.data === HARNESS_ORIGIN && effective.data === HARNESS_ORIGIN ? ok(null) : fail(`unexpected harness origin; expected exactly ${HARNESS_ORIGIN}`);
  };
  const clean = async (): Promise<Result<null>> => {
    const idle = await noOperationInProgress(app);
    if (!idle.ok) return idle;
    const status = await checkedGit("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none");
    if (!status.ok) return status;
    return status.data.length > 0 ? fail("harness checkout has dirty or untracked files; preserve/review them manually before pull (no automatic stash/reset/clean)") : ok(null);
  };
  const branch = async (): Promise<Result<string>> => {
    const result = await command([...gitArgs, "symbolic-ref", "-q", "HEAD"], app, env);
    if (result.code === 1) return ok("detached");
    if (result.code !== 0) return fail(`cannot determine harness branch: ${result.err.trim()}`);
    return result.out.trim() === "refs/heads/main" ? ok("main") : fail(`harness is on branch ${result.out.trim()}; preserve its work and explicitly select main before pull`);
  };
  const unchanged = async (expectBranch: string, expectHead: string, when: string): Promise<Result<null>> => {
    for (const step of [identity, clean]) {
      const result = await step();
      if (!result.ok) return result;
    }
    const now = await branch(), head = await checkedGit("rev-parse", "HEAD");
    if (!now.ok) return now;
    if (!head.ok) return head;
    return now.data === expectBranch && head.data === expectHead ? ok(null) : fail(`harness checkout changed during ${when}; refusing update`);
  };

  return withInstallation(home, true, async installation => {
    for (const step of [identity, clean, () => safeBuildPaths(pkg)]) {
      const result = await step();
      if (!result.ok) return result;
    }
    const beforeBranch = await branch(), before = await checkedGit("rev-parse", "HEAD");
    if (!beforeBranch.ok) return beforeBranch;
    if (!before.ok) return before;
    const version = await checked([bun, "--version"], "bun version check");
    if (!version.ok) return version;
    if (bunTooOld(version.data)) return fail("orca2 pull requires bun >= 1.4.2 on PATH");
    write(`updating harness only: ${app}\nfetching verified origin/main…`);
    const fetched = await withGitCredentials(git, app, env, command, authenticated => checked([
      ...gitArgs, "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap=", HARNESS_ORIGIN, "refs/heads/main:refs/remotes/origin/main",
    ], "git fetch", app, authenticated));
    if (!fetched.ok) return fetched;
    const still = await unchanged(beforeBranch.data, before.data, "fetch");
    if (!still.ok) return still;
    const target = await checkedGit("rev-parse", "refs/remotes/origin/main");
    if (!target.ok) return target;
    if ((await command([...gitArgs, "merge-base", "--is-ancestor", before.data, target.data], app, env)).code !== 0) {
      return fail("harness HEAD is not an ancestor of origin/main; cannot fast-forward. preserve local/review commits in a named branch and reconcile manually. no commits were discarded");
    }
    write(before.data === target.data ? "harness already at origin/main; rebuilding/reinstalling (also retries a previous failed build)…" : `fast-forwarding ${beforeBranch.data} to ${target.data}…`);
    const merged = await checkedGit("merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", target.data);
    if (!merged.ok) return merged;
    const paths = await safeBuildPaths(pkg);
    if (!paths.ok) return paths;
    const artifact = await prepareArtifact(pkg);
    if (!artifact.ok) return artifact;
    write("installing frozen dependencies…");
    const installed = await checked([bun, "install", "--frozen-lockfile"], "dependency installation", pkg);
    if (!installed.ok) return installed;
    write("building harness…");
    const built = await checked([bun, "run", "build"], "harness build", pkg);
    if (!built.ok) return built;
    const settled = await unchanged(beforeBranch.data, target.data, "build");
    if (!settled.ok) return settled;
    const replaced = await installation.replace(artifact.data);
    if (!replaced.ok) return replaced;
    for (const change of await pruneBuildScratch(pkg, true).catch((): { path: string; disposition: string }[] => [])) write(`build scratch: ${change.disposition}`);
    write(`installed ${installation.target} from ${target.data}. scheduling orchestrator updates next.`);
    return ok({ binary: installation.target, from: before.data, to: target.data });
  });
}
