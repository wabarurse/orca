import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-bootstrap-"));
  temporary.push(dir);
  const home = join(dir, "user's home"), bin = join(dir, "bin"), source = join(dir, "source"), cwd = join(dir, "unrelated project");
  for (const path of [home, bin, source, cwd, join(source, "scripts"), join(source, "src"), join(source, "src/core"), join(source, "src/core/install"), join(source, "src/config")]) {
    await mkdir(path, { mode: 0o755 });
  }
  await cp(join(root, "src/config"), join(source, "src/config"), { recursive: true });
  await cp(join(root, "scripts/install.ts"), join(source, "scripts/install.ts"));
  await cp(join(root, "src/core/install/installation.ts"), join(source, "src/core/install/installation.ts"));
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { "install:local": "bun scripts/install.ts", build: "bun build-fixture.ts" } }));
  await writeFile(join(source, "build-fixture.ts"), `import { chmodSync, writeFileSync } from "node:fs";
writeFileSync("dist/orca", "#!/bin/sh\\necho fixture-orca\\n"); chmodSync("dist/orca", 0o755);`);
  await writeFile(join(dir, "git.ts"), `import { cpSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.ORCA_TEST_GIT_LOG!, JSON.stringify(args));
if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(["clone", "--branch", "main", "--single-branch", "https://github.com/wabarurse/parallels.git"])) process.exit(90);
cpSync(process.env.ORCA_TEST_SOURCE!, args[5]!, { recursive: true });`);
  for (const [name, contents] of Object.entries({
    git: '#!/bin/sh\nexec "$ORCA_TEST_BUN" "$ORCA_TEST_GIT" "$@"\n',
    bun: '#!/bin/sh\nif [ "${1-}" = install ]; then\n  [ "${2-}" = --frozen-lockfile ] || exit 91\n  exit "${ORCA_TEST_DEPS_EXIT:-0}"\nfi\nexec "$ORCA_TEST_BUN" "$@"\n',
    tmux: '#!/bin/sh\nexit 0\n',
  })) {
    await writeFile(join(bin, name), contents); await chmod(join(bin, name), 0o755);
  }
  const run = async (args: string[] = [], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(["/bin/sh", "-s", "--", ...args], {
      cwd, stdin: Bun.file(join(root, "install.sh")), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, SHELL: "/bin/bash", ZDOTDIR: "", PATH: `${bin}:${process.env.PATH}`,
        ORCA_TEST_BUN: process.execPath, ORCA_TEST_GIT: join(dir, "git.ts"), ORCA_TEST_GIT_LOG: join(dir, "git.json"), ORCA_TEST_SOURCE: source, ...extra },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr };
  };
  return { dir, home, cwd, run };
}

test("piped installer installs from any directory and refuses an existing app", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "keep"), "project-content");
  await writeFile(join(f.home, ".bashrc"), "# user settings\n", { mode: 0o644 });
  const result = await f.run();
  expect(result.output).toContain("orca installed"); expect(result.code).toBe(0);
  const executable = join(f.home, ".local/bin/orca");
  const receipt = JSON.parse(await readFile(join(f.home, ".local/bin/.orca-install.json"), "utf8"));
  const bytes = await Bun.file(executable).bytes();
  expect(receipt.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  expect(await new Response(Bun.spawn([executable], { stdout: "pipe" }).stdout).text()).toBe("fixture-orca\n");
  expect(await readFile(join(f.cwd, "keep"), "utf8")).toBe("project-content");
  const profile = await readFile(join(f.home, ".bashrc"), "utf8");
  expect(profile).toBe('# user settings\n\n# orca\nexport PATH="$HOME/.local/bin:$PATH"\n');
  const again = await f.run();
  expect(again.code).not.toBe(0); expect(again.output).toContain("use orca pull");
  expect(await Bun.file(executable).bytes()).toEqual(bytes);
  expect(await readFile(join(f.home, ".bashrc"), "utf8")).toBe(profile);
});

test("dependency failure preserves existing binary and shell settings", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".local/bin"), { recursive: true, mode: 0o755 });
  await writeFile(join(f.home, ".local/bin/orca"), "keep-old-command");
  await writeFile(join(f.home, ".bashrc"), "keep-profile");
  const result = await f.run([], { ORCA_TEST_DEPS_EXIT: "42" });
  expect(result.code).toBe(42);
  expect(await readFile(join(f.home, ".local/bin/orca"), "utf8")).toBe("keep-old-command");
  expect(await readFile(join(f.home, ".bashrc"), "utf8")).toBe("keep-profile");
});

test("refuses a symlinked app parent before cloning", async () => {
  const f = await fixture();
  await symlink(f.cwd, join(f.home, ".orca"));
  const result = await f.run();
  expect(result.code).not.toBe(0); expect(result.output).toContain("unsafe directory");
  expect(await Bun.file(join(f.dir, "git.json")).exists()).toBe(false);
});

test("PATH setup is optional", async () => {
  const f = await fixture();
  expect((await f.run(["--no-modify-path"])).code).toBe(0);
  expect(await Bun.file(join(f.home, ".bashrc")).exists()).toBe(false);
});

test("zsh uses ZDOTDIR and does not duplicate an existing PATH entry", async () => {
  const f = await fixture();
  const profile = join(f.cwd, ".zshrc"), before = 'export PATH="$HOME/.local/bin:$PATH"\n# custom\n';
  await writeFile(profile, before, { mode: 0o644 });
  expect((await f.run([], { SHELL: "/bin/zsh", ZDOTDIR: f.cwd })).code).toBe(0);
  expect(await readFile(profile, "utf8")).toBe(before);
  expect(await Bun.file(join(f.home, ".bashrc")).exists()).toBe(false);
});

test("symlinked shell configuration is left for manual PATH setup", async () => {
  const f = await fixture();
  const target = join(f.cwd, "shell-settings");
  await writeFile(target, "keep-settings");
  await symlink(target, join(f.home, ".bashrc"));
  const result = await f.run();
  expect(result.code).toBe(0); expect(result.output).toContain("PATH was not changed");
  expect(await readFile(target, "utf8")).toBe("keep-settings");
});

test("existing legacy state refuses bootstrap and preserves private files", async () => {
  const f = await fixture(), legacy = join(f.home, ".parallels");
  await mkdir(join(legacy, "auth"), { recursive: true });
  await writeFile(join(legacy, "auth", "saved"), "fixture-private");
  const result = await f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain("manual offline migration");
  expect(await readFile(join(legacy, "auth", "saved"), "utf8")).toBe("fixture-private");
});

test("existing config-only state refuses before clone", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".orca"));
  await writeFile(join(f.home, ".orca/config.toml"), "fixture-settings");
  const result = await f.run();
  expect(result.code).toBe(1); expect(result.output).toContain("manual offline migration");
  expect(await readFile(join(f.home, ".orca/config.toml"), "utf8")).toBe("fixture-settings");
  expect(await Bun.file(join(f.dir, "git.json")).exists()).toBe(false);
});
