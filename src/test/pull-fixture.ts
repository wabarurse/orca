// Offline updater boundary: real temporary Git histories; only the network fetch
// and Bun deps/build are intercepted. Never set an updater runtime bypass flag.
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { installBinary } from "../installation";
import { HARNESS_ORIGIN, updateCommand, type UpdateCommand } from "../pull";

export async function pullFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "parallels-pull-")));
  const home = join(root, "home ' $space"), app = join(home, ".parallels", "app"), remote = join(root, "remote ' repo");
  const caller = join(root, "unrelated ' repo"), state = join(root, "relocated state");
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"].includes(key)) delete env[key as keyof typeof env];
  const git = Bun.which("git")!;
  async function g(cwd: string, ...args: string[]) {
    const r = await updateCommand([git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], cwd, env);
    if (r.code) throw new Error(r.err);
    return r.out.trim();
  }
  await mkdir(remote, { recursive: true }); await mkdir(join(home, ".parallels"), { recursive: true });
  await g(remote, "init", "-q", "-b", "main");
  await writeFile(join(remote, ".gitignore"), "dist\nnode_modules\n.*.bun-build\n");
  await writeFile(join(remote, "tracked"), "old content\n");
  await writeFile(join(remote, "fixture.ts"), 'console.log("updated standalone fixture");\n');
  await g(remote, "add", "."); await g(remote, "commit", "-qm", "initial");
  const before = await g(remote, "rev-parse", "HEAD");
  await g(root, "clone", "--no-hardlinks", remote, app);
  await g(app, "remote", "set-url", "origin", HARNESS_ORIGIN);
  await writeFile(join(remote, "tracked"), "new content\n");
  await g(remote, "commit", "-qam", "update");
  const after = await g(remote, "rev-parse", "HEAD");
  await mkdir(caller); await g(caller, "init", "-q", "-b", "caller-branch");
  await writeFile(join(caller, "precious"), "caller committed\n"); await g(caller, "add", "."); await g(caller, "commit", "-qm", "caller");
  await writeFile(join(caller, "precious"), "caller uncommitted\n"); await writeFile(join(caller, "untracked"), "do not touch\n");
  await mkdir(state); await writeFile(join(state, "keep"), "state sentinel");
  await writeFile(join(home, ".zshrc"), "shell sentinel");
  const source = join(root, "old-executable"); await writeFile(source, "old executable", { mode: 0o755 });
  const target = await installBinary(source, home);
  const bin = join(home, ".local", "bin"), calls: string[][] = [], output: string[] = [];
  const command: UpdateCommand = async (argv, cwd, childEnv) => {
    if (cwd !== app) throw new Error(`command escaped app: ${cwd}`);
    calls.push(argv);
    if (argv.includes("--show-scope")) {
      // Read only fixture global/local config, never host system credentials.
      return updateCommand(argv, cwd, { ...childEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null" });
    }
    if (basename(argv[0]!) === "bun") {
      if (argv[1] === "--version") return { code: 0, out: "1.4.2\n", err: "" };
      if (argv.slice(1).join(" ") === "install --frozen-lockfile") return { code: 0, out: "", err: "" };
      if (argv.slice(1).join(" ") !== "run build") throw new Error(`unexpected bun call: ${argv}`);
      await writeFile(join(app, "dist", "parallels"), "new executable", { mode: 0o755 });
      await chmod(join(app, "dist", "parallels"), 0o755);
      return { code: 0, out: "", err: "" };
    }
    if (argv.includes("fetch")) {
      if (!argv.includes(HARNESS_ORIGIN)) throw new Error("fetch did not specify the verified origin");
      // Real fetch against a local temporary repo, with identical refspec/flags.
      return updateCommand(argv.map(a => a === HARNESS_ORIGIN ? remote : a), cwd, childEnv);
    }
    return updateCommand(argv, cwd, childEnv);
  };
  const options = { home, command, write: (text: string) => output.push(text) };
  const binary = () => readFile(target, "utf8");
  return { root, home, app, remote, caller, state, target, bin, source, before, after, g, calls, output, options, command, binary };
}
