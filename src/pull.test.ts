import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installBinary } from "./installation";
import { HARNESS_ORIGIN, pullHarness } from "./pull";
import { pullFixture } from "./test/pull-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const f = await pullFixture(); roots.push(f.root); return f; }
const fetched = (calls: string[][]) => calls.some(a => a.includes("fetch"));

test("pull fast-forwards only the dedicated main clone, freezes deps and reinstalls on no-op", async () => {
  const f = await fixture(), cwd = process.cwd();
  const callerHead = await f.g(f.caller, "rev-parse", "HEAD"), callerStatus = await f.g(f.caller, "status", "--porcelain");
  await pullHarness(f.options);
  expect(process.cwd()).toBe(cwd);
  expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(f.after);
  expect(await f.g(f.app, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await f.binary()).toBe("new executable");
  expect(f.calls.find(a => a.includes("fetch"))).toContain("--refmap=");
  expect(f.calls.find(a => a.includes("merge"))).toContain("--ff-only");
  expect(f.calls.filter(a => a.includes("install")).map(a => a.slice(1))).toEqual([["install", "--frozen-lockfile"]]);
  expect(await f.g(f.caller, "rev-parse", "HEAD")).toBe(callerHead);
  expect(await f.g(f.caller, "status", "--porcelain")).toBe(callerStatus);
  expect(await readFile(join(f.caller, "precious"), "utf8")).toBe("caller uncommitted\n");
  expect(await readFile(join(f.state, "keep"), "utf8")).toBe("state sentinel");
  expect(await readFile(join(f.home, ".zshrc"), "utf8")).toBe("shell sentinel");
  await pullHarness(f.options);
  expect(f.output.join("\n")).toContain("already at origin/main");
  expect(f.calls.filter(a => a.includes("install"))).toHaveLength(2);
  expect(await f.g(f.app, "status", "--porcelain")).toBe("");
});

test("ancestral detached reviewed-head installs advance while staying detached", async () => {
  const f = await fixture(); await f.g(f.app, "switch", "--detach", f.before);
  await pullHarness(f.options);
  expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(f.after);
  expect(await f.g(f.app, "branch", "--show-current")).toBe("");
  expect(await f.g(f.app, "rev-parse", "refs/heads/main")).toBe(f.before);
});

for (const mode of ["dirty", "untracked", "staged", "branch", "main-ahead", "diverged", "detached-diverged", "merge", "rebase", "sequencer", "git-lock"] as const) {
  test(`refuses ${mode} without discarding changes or replacing the executable`, async () => {
    const f = await fixture();
    if (["dirty", "staged", "main-ahead", "diverged", "detached-diverged"].includes(mode)) await writeFile(join(f.app, "tracked"), "local work\n");
    if (mode === "staged") await f.g(f.app, "add", ".");
    if (["main-ahead", "diverged", "detached-diverged"].includes(mode)) await f.g(f.app, "commit", "-qam", "local work");
    if (mode === "main-ahead") await f.g(f.remote, "reset", "--soft", f.before); // fixture remote only
    if (mode === "detached-diverged") await f.g(f.app, "switch", "--detach");
    if (mode === "branch") await f.g(f.app, "switch", "-c", "keep-local");
    if (mode === "untracked") await writeFile(join(f.app, "local-file"), "keep");
    if (mode === "merge") await writeFile(join(f.app, ".git", "MERGE_HEAD"), f.after);
    if (mode === "rebase") await mkdir(join(f.app, ".git", "rebase-merge"));
    if (mode === "sequencer") await mkdir(join(f.app, ".git", "sequencer"));
    if (mode === "git-lock") await writeFile(join(f.app, ".git", "index.lock"), "keep");
    const head = await f.g(f.app, "rev-parse", "HEAD"), status = await f.g(f.app, "status", "--porcelain");
    await expect(pullHarness(f.options)).rejects.toThrow();
    expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(head);
    expect(await f.g(f.app, "status", "--porcelain")).toBe(status);
    expect(await f.binary()).toBe("old executable");
    expect(f.calls.some(a => a.includes("merge") || a.includes("install"))).toBe(false);
    if (!["main-ahead", "diverged", "detached-diverged"].includes(mode)) expect(fetched(f.calls)).toBe(false);
  });
}

for (const mode of ["wrong-origin", "missing-origin", "rewritten-origin", "multiple-origins", "missing-app", "unowned-binary", "missing-binary", "modified-binary", "app-symlink", "git-symlink", "nested-git-symlink", "worktree", "alternate", "writable-directory"] as const) {
  test(`refuses ${mode} before fetching`, async () => {
    const f = await fixture();
    if (mode === "wrong-origin") await f.g(f.app, "remote", "set-url", "origin", f.remote);
    if (mode === "missing-origin") await f.g(f.app, "remote", "remove", "origin");
    if (mode === "rewritten-origin") await f.g(f.app, "config", `url.${f.remote}.insteadOf`, HARNESS_ORIGIN);
    if (mode === "multiple-origins") await f.g(f.app, "config", "--add", "remote.origin.url", f.remote);
    if (mode === "missing-app") await rename(f.app, join(f.root, "preserved-app"));
    if (mode === "unowned-binary") await rm(join(f.bin, ".parallels-install.json"));
    if (mode === "missing-binary") await rm(f.target);
    if (mode === "modified-binary") await writeFile(f.target, "modified executable");
    if (["app-symlink", "git-symlink", "nested-git-symlink"].includes(mode)) {
      const path = mode === "app-symlink" ? f.app : join(f.app, ".git", ...(mode === "nested-git-symlink" ? ["refs", "remotes", "origin"] : []));
      const outside = join(f.root, "preserved"); await rename(path, outside); await symlink(outside, path);
    }
    if (mode === "worktree") {
      await rename(f.app, join(f.root, "preserved-app"));
      await f.g(join(f.root, "preserved-app"), "worktree", "add", "--detach", f.app);
    }
    if (mode === "alternate") await writeFile(join(f.app, ".git", "objects", "info", "alternates"), join(f.remote, ".git", "objects"));
    if (mode === "writable-directory") await chmod(f.app, 0o777);
    await expect(pullHarness(f.options)).rejects.toThrow();
    expect(fetched(f.calls)).toBe(false);
    if (mode !== "missing-binary") expect(await f.binary()).toBe(mode === "modified-binary" ? "modified executable" : "old executable");
  });
}

for (const phase of ["fetch", "install", "build", "replace", "dist-symlink", "node_modules-symlink"] as const) {
  test(`${phase} failure preserves previous executable and removes only the acquired lock`, async () => {
    const f = await fixture();
    if (phase.endsWith("symlink")) {
      const outside = join(f.root, "outside"); await mkdir(outside);
      await symlink(outside, join(f.app, phase === "dist-symlink" ? "dist" : "node_modules"));
    }
    const command: typeof f.command = async (argv, cwd, env) => {
      if (argv.includes(phase)) return { code: 31, out: "", err: "fixture failure" };
      const result = await f.command(argv, cwd, env);
      if (phase === "replace" && argv.includes("build")) await chmod(join(f.app, "dist", "parallels"), 0o644);
      return result;
    };
    await expect(pullHarness({ ...f.options, command })).rejects.toThrow();
    expect(await f.binary()).toBe("old executable");
    expect((await readdir(f.bin)).sort()).toEqual([".parallels-install.json", "parallels"]);
    expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(phase === "fetch" || phase.endsWith("symlink") ? f.before : f.after);
    if (phase.endsWith("symlink")) expect(await readdir(join(f.root, "outside"))).toEqual([]);
    else { // A no-op retry after a failed build is deliberately not skipped.
      await pullHarness(f.options);
      expect(await f.binary()).toBe("new executable");
    }
  });
}

test("one shared lock covers fetch, dependencies, build and manual installation", async () => {
  const f = await fixture();
  let checked = 0;
  await pullHarness({ ...f.options, command: async (argv, cwd, env) => {
    if (argv.includes("fetch") || argv.includes("install") || argv.includes("build")) {
      await expect(pullHarness(f.options)).rejects.toThrow("lock already exists");
      await expect(installBinary(f.source, f.home)).rejects.toThrow("lock already exists");
      checked++;
    }
    return f.command(argv, cwd, env);
  } });
  expect(checked).toBe(3);
  const lock = join(f.bin, ".parallels-install.lock"); await mkdir(lock); await writeFile(join(lock, "keep"), "stale or live");
  await expect(pullHarness(f.options)).rejects.toThrow("lock already exists");
  expect(await readFile(join(lock, "keep"), "utf8")).toBe("stale or live");
});

for (const phase of ["fetch", "build"] as const) {
  test(`concurrent source edits during ${phase} abort before executable replacement`, async () => {
    const f = await fixture();
    await expect(pullHarness({ ...f.options, command: async (argv, cwd, env) => {
      const result = await f.command(argv, cwd, env);
      if (argv.includes(phase)) await writeFile(join(f.app, "tracked"), "concurrent work");
      return result;
    } })).rejects.toThrow("dirty");
    expect(await f.binary()).toBe("old executable");
    expect(await readFile(join(f.app, "tracked"), "utf8")).toBe("concurrent work");
  });
}

test("Git overrides/global rewrites are ignored and local hooks do not execute", async () => {
  const f = await fixture();
  await writeFile(join(f.home, ".gitconfig"), `[url "${f.remote}"]\n insteadOf = https://github.com/\n`);
  await writeFile(join(f.app, ".git", "hooks", "post-merge"), '#!/bin/sh\nprintf unsafe > hook-ran\n', { mode: 0o755 });
  const old = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  Object.assign(process.env, { GIT_DIR: join(f.caller, ".git"), GIT_WORK_TREE: f.caller, GIT_CONFIG_COUNT: "not-valid" });
  try { await pullHarness(f.options); }
  finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  expect(await Bun.file(join(f.app, "hook-ran")).exists()).toBe(false);
  expect(await f.binary()).toBe("new executable");
});

test("old Bun is refused before fetch, with actionable prerequisite", async () => {
  const f = await fixture();
  await expect(pullHarness({ ...f.options, command: (argv, cwd, env) => argv[1] === "--version"
    ? Promise.resolve({ code: 0, out: "1.3.99", err: "" }) : f.command(argv, cwd, env) })).rejects.toThrow("Bun >= 1.4.2");
  expect(fetched(f.calls)).toBe(false);
  expect(await f.binary()).toBe("old executable");
});


test("ignored local files that collide with incoming tracked files are not overwritten", async () => {
  const f = await fixture();
  await mkdir(join(f.app, "dist")); await mkdir(join(f.remote, "dist"));
  await writeFile(join(f.app, "dist", "collision"), "ignored local work");
  await writeFile(join(f.remote, "dist", "collision"), "upstream work");
  await f.g(f.remote, "add", "-f", "dist/collision"); await f.g(f.remote, "commit", "-qm", "new tracked path");
  await expect(pullHarness(f.options)).rejects.toThrow("git merge failed");
  expect(await readFile(join(f.app, "dist", "collision"), "utf8")).toBe("ignored local work");
  expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(f.before);
  expect(await f.binary()).toBe("old executable");
});

for (const mode of ["head", "origin", "branch"] as const) {
  test(`concurrent ${mode} changes during fetch/build are not silently installed`, async () => {
    const f = await fixture();
    await expect(pullHarness({ ...f.options, command: async (argv, cwd, env) => {
      const result = await f.command(argv, cwd, env);
      if (mode === "head" && argv.includes("fetch")) await f.g(f.app, "merge", "--ff-only", f.after);
      if (mode === "origin" && argv.includes("fetch")) await f.g(f.app, "remote", "set-url", "origin", f.remote);
      if (mode === "branch" && argv.includes("build")) await f.g(f.app, "switch", "-c", "concurrent-work");
      return result;
    } })).rejects.toThrow();
    expect(await f.binary()).toBe("old executable");
  });
}
