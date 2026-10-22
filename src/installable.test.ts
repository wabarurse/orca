import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installBinary } from "../scripts/install";
import { open } from "./transcript";
import { agentCommand, slug } from "./runner";
import pkg from "../package.json";

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
  for (const args of [["help"], ["--help"], ["-h"], ["start", "--help"]]) {
    const result = await exec([installed, ...args]);
    expect(result.code).toBe(0); expect(result.out).toContain("parallels start");
  }
  for (const args of [["not-a-command"], ["msg"], ["agent"], ["agent-exit"], ["version", "extra"], ["start", "--bad"], ["agent", "--project", "p", "--role", "invalid"], ["agent-exit", "--project", "p", "--role", "worker", "--branch", "b", "--run", "r", "--code", "NaN"]]) {
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

const branch = "feat/it's-$space", run = "run-'$space";
async function seed(project: string, role: "orchestrator" | "worker" | "reviewer") {
  const base = join(state, "projects", project), repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  const cwd = role === "orchestrator" ? repo : join(base, "worktrees", slug(branch));
  mkdirSync(cwd, { recursive: true });
  const id = role === "orchestrator" ? role : `${role}-${slug(branch)}`;
  const t = open(join(base, "transcripts", `${id}.jsonl`));
  await t.append({ type: "meta", role, model: "m" });
  await t.append({ type: "message", message: { role: "user", content: "offline fixture" } });
  return { cwd, base };
}
const launch = (project: string, role: string) => [probe, "launch", "--project", project, "--role", role, "--branch", branch, "--run", run];

for (const role of ["orchestrator", "worker", "reviewer"] as const) {
  test(`relocated compiled runner launches ${role} through fake tmux into correct cwd with a fake provider`, async () => {
    resetLog();
    const project = `normal-${role}`, { cwd } = await seed(project, role);
    const result = await exec(launch(project, role));
    expect(result.code).toBe(0);
    const rows = records(), agent = rows.find(row => row.cmd === "agent");
    expect(agent).toMatchObject({ cwd, home: state, executable: probe });
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
    script("git", 'printf "%s" "$PWD" > "$HOME/git-cwd"\nprintf "?? one\\n?? two\\n"');
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

test("bare and explicit installed startup retain invoking cwd and reuse origin clone, excluding local edits", async () => {
  const origin = join(root, "origin repo"), checkout = join(root, "caller ' checkout"), isolated = join(root, "pty-state");
  mkdirSync(origin); mkdirSync(isolated);
  expect((await exec(["git", "init", "-q", "-b", "main"], origin)).code).toBe(0);
  writeFileSync(join(origin, "committed"), "from origin");
  expect((await exec(["git", "add", "."], origin)).code).toBe(0);
  expect((await exec(["git", "-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "fixture"], origin)).code).toBe(0);
  expect((await exec(["git", "clone", origin, checkout])).code).toBe(0);
  writeFileSync(join(checkout, "committed"), "uncommitted edit");
  writeFileSync(join(checkout, "untracked"), "not cloned");
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
      const clone = join(isolated, "projects", current[0]!, "repo");
      expect(readFileSync(join(clone, "committed"), "utf8")).toBe("from origin");
      expect(existsSync(join(clone, "untracked"))).toBe(false);
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
