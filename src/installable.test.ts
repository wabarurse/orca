import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installBinary } from "../scripts/install";
import { open } from "./transcript";
import { agentCommand, slug } from "./runner";
import pkg from "../package.json";
import { pullFixture } from "./test/pull-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "parallels-relocated-")));
const home = join(root, "home ' $space"), state = join(root, "state ' $space"), bin = join(root, "fake-bin");
const installed = join(home, ".local", "bin", "parallels");
const probe = join(root, "relocated ' $probe");
const log = join(root, "probe.jsonl");
const source = resolve(import.meta.dir, "..");
const env = { HOME: home, PARALLELS_HOME: state, PATH: `${bin}:/usr/bin:/bin`, TERM: "xterm-256color", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PROBE: probe, PROBE_LOG: log };

async function exec(argv: string[], cwd = root, extra: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}
function script(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
function records(): any[] { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function resetLog() { writeFileSync(log, ""); }

beforeAll(async () => {
  mkdirSync(home); mkdirSync(state); mkdirSync(bin);
  const build = join(root, "build ' directory"); mkdirSync(build);
  const artifact = join(build, "parallels");
  const result = await exec([process.execPath, "build", join(source, "src/cli.ts"), "--compile", "--outfile", artifact]);
  expect(result.code).toBe(0);
  expect(await installBinary(artifact, home)).toBe(installed);
  const compiledProbe = join(build, "probe");
  const fixture = await exec([process.execPath, "build", join(source, "src/test/installed-probe.ts"), "--compile", "--outfile", compiledProbe]);
  expect(fixture.code).toBe(0);
  const { copyFileSync } = await import("node:fs"); copyFileSync(compiledProbe, probe); chmodSync(probe, 0o755);
  rmSync(build, { recursive: true }); // No original output remains; children must use their current executable.
  script("tmux", 'exec "$PROBE" fake-tmux "$@"');
  script("gh", "exit 1");
  expect(Bun.which("bun", { PATH: env.PATH })).toBe(null);
}, 120_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("relocated installed CLI preserves help, errors, version, msg and state relocation without runtime Bun", async () => {
  expect(await exec([installed, "version"])).toEqual({ code: 0, out: `${pkg.version}\n`, err: "" });
  for (const args of [["help"], ["--help"], ["-h"], ["start", "--help"], ["pull", "--help"]]) {
    const result = await exec([installed, ...args]);
    expect(result.code).toBe(0); expect(result.out).toContain("parallels start");
  }
  for (const args of [["pull", "extra"], ["not-a-command"], ["msg"], ["agent"], ["agent-exit"], ["version", "extra"], ["start", "--bad"], ["agent", "--project", "p", "--role", "invalid"], ["agent-exit", "--project", "p", "--role", "worker", "--branch", "b", "--run", "r", "--code", "NaN"]]) {
    const result = await exec([installed, ...args]);
    expect(result.code).toBe(1); expect(result.err).toContain("usage:");
  }
  for (const args of [[], ["start"]]) expect((await exec([installed, ...args])).err).toContain("interactive terminal");
  expect((await exec([installed, "msg", "messages", "literal ' $() --help"])).code).toBe(0);
  const inbox = join(state, "projects", "messages", "inbox", "orchestrator");
  const files = readdirSync(inbox).filter(f => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(inbox, files[0]!), "utf8")).text).toBe("literal ' $() --help");
  expect(existsSync(join(home, ".parallels"))).toBe(false);
});

test("relocated compiled image pipeline embeds native fixture script, storage and both serializers without runtime Bun", async () => {
  const result = await exec([probe, "images"]);
  expect(result.code).toBe(0); expect(result.err).toBe("");
  expect(JSON.parse(result.out)).toEqual({ images: 1, claude: true, codex: true, nativeFixture: process.platform === "darwin" });
  expect(result.out).not.toContain("base64");
});

const branch = "feat/it's-$space", run = "run-'$space";
async function seed(project: string, role: "orchestrator" | "worker" | "reviewer") {
  const base = join(state, "projects", project), repo = join(root, `original-${project}`);
  mkdirSync(base, { recursive: true });
  expect((await exec(["git", "init", "-q", "-b", "main", repo])).code).toBe(0);
  expect((await exec(["git", "-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fixture"], repo)).code).toBe(0);
  const worktreeId = crypto.randomUUID();
  writeFileSync(join(base, "repository.json"), JSON.stringify({ version: 1, directory: repo, branch: "main", worktreeId }));
  const cwd = role === "orchestrator" ? repo : join(`${repo}.parallels-worktrees`, worktreeId, slug(branch));
  if (role !== "orchestrator") expect((await exec(["git", "worktree", "add", "-b", branch, cwd], repo)).code).toBe(0);
  const id = role === "orchestrator" ? role : `${role}-${slug(branch)}`;
  const t = open(join(base, "transcripts", `${id}.jsonl`));
  await t.append({ type: "meta", role, model: "m" });
  // Orchestrators require fresh durable input; saved history alone never resumes
  // a turn (the same receipt/ownership contract as an interactive session).
  if (role === "orchestrator") expect((await exec([installed, "msg", project, "offline fixture"])).code).toBe(0);
  else await t.append({ type: "message", message: { role: "user", content: "offline fixture" } });
  return { cwd, base };
}
const launch = (project: string, role: string) => [probe, "launch", "--project", project, "--role", role, "--branch", branch, "--run", run];

for (const role of ["orchestrator", "worker", "reviewer"] as const) {
  test(`relocated compiled runner launches ${role} through fake tmux into correct cwd with a fake provider`, async () => {
    resetLog();
    const project = `normal-${role}`, { cwd } = await seed(project, role);
    const result = await exec(launch(project, role), root, { FIXTURE_LOGIN: "current-login" });
    expect(result.code).toBe(0);
    const rows = records(), agent = rows.find(row => row.cmd === "agent");
    expect(agent).toMatchObject({ cwd, home: state, executable: probe, login: "current-login" });
    expect(agent.stale).toBeUndefined();
    expect(rows.find(row => row.providerCalls !== undefined)).toEqual({ providerCalls: 1, role });
    expect(rows.find(row => row.exit !== undefined)).toMatchObject({ exit: 0, cwd });
    expect(rows.some(row => row.cmd === "agent-exit")).toBe(false);
    expect(rows.find(row => row.tmux?.[0] === "new-window").tmux).toContain("--");
  });
}

for (const exit of ["0", "70", "19", "kill"]) {
  test(`compiled worker wrapper preserves ${exit} exit and crash follow-up, even if follow-up fails`, async () => {
    resetLog();
    const project = `exit-${exit}`, { cwd, base } = await seed(project, "worker");
    // Dirty status must be read in the worktree, not the installation/source dir.
    script("git", 'if [ "$1" = "--no-optional-locks" ] && [ "$2" = "status" ]; then\n  printf "%s" "$PWD" > "$HOME/git-cwd"\n  printf "?? one\\n?? two\\n"\nelse\n  exec /usr/bin/git "$@"\nfi');
    try {
      const result = await exec(launch(project, "worker"), root, { PROBE_EXIT: exit, PROBE_FOLLOWUP_EXIT: "23" });
      expect(result.code).toBe(0); // tmux itself accepted the launch
      const rows = records(), code = exit === "kill" ? 137 : Number(exit);
      expect(rows.find(row => row.exit !== undefined)).toMatchObject({ exit: code, cwd });
      const followups = rows.filter(row => row.cmd === "agent-exit");
      expect(followups).toHaveLength(code === 0 || code === 70 ? 0 : 1);
      if (followups.length) {
        expect(followups[0]).toMatchObject({ cwd, home: state, executable: probe });
        expect(followups[0].args).toEqual(["--project", project, "--role", "worker", "--branch", branch, "--run", run, "--code", String(code)]);
        const inbox = join(base, "inbox", "orchestrator"), messages = readdirSync(inbox).filter(f => f.endsWith(".json"));
        expect(messages).toHaveLength(1);
        const notice = JSON.parse(readFileSync(join(inbox, messages[0]!), "utf8")).text;
        expect(notice).toContain("[agent-exit]"); expect(notice).toContain(`code ${code}`); expect(notice).toContain("2");
        expect(readFileSync(join(home, "git-cwd"), "utf8")).toBe(cwd);
      }
    } finally { rmSync(join(bin, "git")); }
  });
}

test("actual installed internal agent and agent-exit settle a startup failure once without credentials", async () => {
  const previous = process.env.PARALLELS_HOME;
  process.env.PARALLELS_HOME = state;
  let argv: string[];
  try { argv = agentCommand({ project: "actual", role: "reviewer", branch }, run, [installed]); }
  finally { if (previous === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = previous; }
  const result = await exec(argv);
  expect(result.code).toBe(70); expect(result.err).toContain("spawn seeds it");
  const inbox = join(state, "projects", "actual", "inbox", "orchestrator");
  expect(readdirSync(inbox).filter(f => f.endsWith(".json"))).toHaveLength(1);
  expect((await exec([installed, "agent-exit", "--project", "actual", "--role", "reviewer", "--branch", branch, "--run", run, "--code", "70"])).code).toBe(0);
  expect(readdirSync(inbox).filter(f => f.endsWith(".json"))).toHaveLength(1);
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  expect(check()).toBe(true);
}

test("bare and explicit installed startup reuse the original checkout with its local edits", async () => {
  const origin = join(root, "origin repo"), checkout = join(root, "caller ' checkout"), isolated = join(root, "pty-state");
  mkdirSync(origin); mkdirSync(isolated);
  expect((await exec(["git", "init", "-q", "-b", "main"], origin)).code).toBe(0);
  writeFileSync(join(origin, "committed"), "from origin");
  expect((await exec(["git", "add", "."], origin)).code).toBe(0);
  expect((await exec(["git", "-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "fixture"], origin)).code).toBe(0);
  expect((await exec(["git", "clone", origin, checkout])).code).toBe(0);
  writeFileSync(join(checkout, "committed"), "uncommitted edit");
  writeFileSync(join(checkout, "untracked"), "local file");
  const cwd = join(checkout, "nested"); mkdirSync(cwd);
  let projects: string[] = [];
  for (const args of [[], ["start"]]) {
    let output = "";
    const decoder = new TextDecoder();
    const child = Bun.spawn([installed, ...args], {
      cwd, env: { ...env, PARALLELS_HOME: isolated },
      terminal: { cols: 110, rows: 28, data(_term, data) { output += decoder.decode(data, { stream: true }); } },
    });
    try {
      await until(() => output.includes("orch-") && output.includes("origin repo"));
      child.terminal!.write("/quit\r");
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(0);
      const current = readdirSync(join(isolated, "projects")).filter(f => f.startsWith("orch-"));
      expect(current).toHaveLength(1);
      if (projects.length) expect(current).toEqual(projects);
      projects = current;
      const project = join(isolated, "projects", current[0]!);
      const binding = JSON.parse(readFileSync(join(project, "repository.json"), "utf8"));
      expect(binding.directory).toBe(realpathSync(checkout));
      expect(binding.branch).toBe("main");
      expect(existsSync(join(project, "repo"))).toBe(false);
      expect(readFileSync(join(binding.directory, "untracked"), "utf8")).toBe("local file");
      expect(readFileSync(join(checkout, "committed"), "utf8")).toBe("uncommitted edit");
    } finally { if (child.exitCode === null) child.kill(); await child.exited; child.terminal?.close(); }
  }
}, 30_000);

test("development CLI re-entry uses absolute Bun without Bun on PATH", async () => {
  const previous = process.env.PARALLELS_HOME;
  process.env.PARALLELS_HOME = state;
  let argv: string[];
  try { argv = agentCommand({ project: "development", role: "worker", branch }, run); }
  finally { if (previous === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = previous; }
  expect(argv).toContain(process.execPath);
  const result = await exec(argv);
  expect(result.code).toBe(70); expect(result.err).toContain("spawn seeds it");
  expect((await exec([process.execPath, join(source, "src/cli.ts"), "version"])).out).toBe(`${pkg.version}\n`);
});

test("local install script builds from its checkout, upgrades fixture HOME, and leaves state untouched", async () => {
  const sentinel = join(state, "config.toml");
  writeFileSync(sentinel, "# fixture state, do not edit\n");
  const result = await exec([process.execPath, join(source, "scripts/install.ts")], root);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Installed");
  expect((await exec([installed, "version"])).out).toBe(`${pkg.version}\n`);
  expect(readFileSync(sentinel, "utf8")).toBe("# fixture state, do not edit\n");
  expect(existsSync(join(home, ".parallels"))).toBe(false);
  expect(existsSync(join(home, ".zshrc"))).toBe(false);
}, 30_000);


test("installed standalone pull from an unrelated dirty repo updates only the dedicated clone via offline process boundaries", async () => {
  const f = await pullFixture();
  try {
    await installBinary(installed, f.home);
    const oldHash = new Bun.CryptoHasher("sha256").update(readFileSync(f.target)).digest("hex");
    const callerHead = await f.g(f.caller, "rev-parse", "HEAD"), callerStatus = await f.g(f.caller, "status", "--porcelain");
    const tools = join(f.root, "offline tools"), trace = join(f.root, "commands.jsonl"), boundary = join(f.root, "boundary.ts");
    mkdirSync(tools);
    const realGit = Bun.which("git")!;
    writeFileSync(boundary, `
      import { appendFileSync } from "node:fs";
      const [kind, ...args] = process.argv.slice(2);
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind, args, cwd: process.cwd(), gitDir: process.env.GIT_DIR }) + "\\n");
      if (process.cwd() !== ${JSON.stringify(f.app)}) throw new Error("escaped app");
      let command;
      if (kind === "git") {
        if (args.includes("fetch")) {
          const i = args.indexOf("https://github.com/wabarurse/parallels.git");
          if (i < 0) throw new Error("unexpected fetch target");
          args[i] = ${JSON.stringify(f.remote)};
        }
        command = [${JSON.stringify(realGit)}, ...args];
      } else if (args.join(" ") === "--version") {
        console.log(Bun.version); process.exit(0);
      } else if (args.join(" ") === "install --frozen-lockfile") {
        process.exit(0); // offline fixture has no dependencies
      } else if (args.join(" ") === "run build") {
        command = [${JSON.stringify(process.execPath)}, "build", "fixture.ts", "--compile", "--outfile", "dist/parallels"];
      } else throw new Error("unexpected build command");
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      process.exit(await child.exited);
    `);
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    for (const tool of ["git", "bun"]) writeFileSync(join(tools, tool), `#!/bin/sh
exec ${quote(process.execPath)} ${quote(boundary)} ${tool} "$@"
`, { mode: 0o755 });
    const result = await exec([f.target, "pull"], f.caller, {
      HOME: f.home, PARALLELS_HOME: f.state, PATH: `${tools}:/usr/bin:/bin`,
      GIT_DIR: join(f.caller, ".git"), GIT_WORK_TREE: f.caller, GIT_CONFIG_COUNT: "invalid",
    });
    expect({ code: result.code, err: result.err, status: await f.g(f.app, "status", "--porcelain") }).toEqual({ code: 0, err: "", status: "" });
    expect(result.out).toContain(`Installed ${f.target} from ${f.after}`);
    expect(result.out).toContain("Existing processes were not restarted");
    expect(await f.g(f.app, "rev-parse", "HEAD")).toBe(f.after);
    expect(new Bun.CryptoHasher("sha256").update(readFileSync(f.target)).digest("hex")).not.toBe(oldHash);
    expect(await exec([f.target, "version"], f.caller)).toEqual({ code: 0, out: "updated standalone fixture\n", err: "" });
    expect(await f.g(f.caller, "rev-parse", "HEAD")).toBe(callerHead);
    expect(await f.g(f.caller, "status", "--porcelain")).toBe(callerStatus);
    expect(readFileSync(join(f.caller, "precious"), "utf8")).toBe("caller uncommitted\n");
    expect(readFileSync(join(f.state, "keep"), "utf8")).toBe("state sentinel");
    const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.every(c => c.cwd === f.app && c.gitDir === undefined)).toBe(true);
    expect(calls.filter(c => c.kind === "bun").map(c => c.args)).toEqual([["--version"], ["install", "--frozen-lockfile"], ["run", "build"]]);
    const missingBun = await exec([installed, "pull"], f.caller, { HOME: f.home, PARALLELS_HOME: f.state, PATH: "/usr/bin:/bin" });
    expect(missingBun.code).toBe(1);
    expect(missingBun.err).toContain("requires bun on PATH");
    expect(missingBun.err).toContain("installed executable was not replaced");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 120_000);
