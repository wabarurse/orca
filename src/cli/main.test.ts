import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { accounts } from "../login/accounts";
import { login } from "../tui/commands/commands";

test("`orca version` prints the package.json version", async () => {
  const proc = Bun.spawn(["bun", "src/cli/main.ts", "version"], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toBe(`${pkg.version}\n`);
});

test("login uses subscriptions despite API keys and rejects invalid input", async () => {
  const home = await mkdtemp(join(tmpdir(), "orca-login-auth-"));
  const env = { ORCA_HOME: process.env.ORCA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.ORCA_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  await mkdir(join(home, "projects", "p", "repo"), { recursive: true });
  await Bun.write(join(home, "claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 },
  }));
  let output = "";
  const io = { write: (s: string) => { output += s; }, signal: new AbortController().signal };
  try {
    expect(await login("anthropic personal --from-claude-code", io)).toContain("now using anthropic:personal");
    expect(output).not.toContain("API billing");
    const config = Bun.TOML.parse(await Bun.file(join(home, "config.toml")).text());
    expect(config).toMatchObject({ account: "personal" });
    const tokens = await Bun.file(join(home, "auth", "anthropic", "personal.json")).json();
    expect(tokens.accessToken).toBe("test-access");
    const list = await accounts();
    expect(list.find((a) => a.id === "anthropic:personal")).toMatchObject({ ok: true, active: true, source: "claude code (claude subscription)" });
    expect(await login("codex --api-key", io)).toBe("usage: /login openai [profile] [--from-codex]");
    expect(output).not.toContain("OpenAI API key");
    await expect(login("anthropic ../outside --from-claude-code", io)).rejects.toThrow("profile must");
    expect(output).not.toContain("test-access");
    expect(output).not.toContain("test-refresh");
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(home, { recursive: true, force: true });
  }
});

test("offline CLI usage and owned errors are lowercase without changing supplied command values", async () => {
  for (const args of [["help"], ["UnknownCommand"]]) {
    const proc = Bun.spawn(["bun", "src/cli/main.ts", ...args], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(args[0] === "help" ? 0 : 1);
    expect(stdout + stderr).toMatchSnapshot();
    if (args[0] === "help") expect(stdout).not.toMatch(/[A-Z]/);
    else expect(stderr).toContain("UnknownCommand");
  }
});

test("`orca stop <project>` refuses bad input, reports an idle project and stops a daemon through the channel", async () => {
  const home = await mkdtemp(join(tmpdir(), "orca-stop-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli/main.ts", ...args], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe", env: { ...process.env, ORCA_HOME: home } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  try {
    expect((await run("stop")).stderr).toContain("expected stop <project>");
    expect((await run("stop", "nope")).stderr).toContain("no project named nope");
    await mkdir(join(home, "projects", "p", "repo"), { recursive: true });
    expect(await run("stop", "p")).toMatchObject({ code: 0, stdout: "p: no orchestrator daemon is running\n" });
    // A recorded live daemon (a shell standing in, which exits once the stop request lands) is asked, then waited for.
    const commands = join(home, "projects", "p", "orchestrator", "commands");
    const child = Bun.spawn(["sh", "-c", `while ! ls "$1"/*.json >/dev/null 2>&1; do sleep 0.1; done`, "sh", commands]);
    await mkdir(join(home, "daemon-locks", "p"), { recursive: true });
    await Bun.write(join(home, "daemon-locks", "p", "owner.json"), JSON.stringify({ pid: child.pid, since: new Date().toISOString(), project: "p" }));
    try { expect(await run("stop", "p")).toMatchObject({ code: 0, stdout: `p: orchestrator daemon (pid ${child.pid}) stopped\n` }); }
    finally { child.kill(); }
    expect(await child.exited).toBe(0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
