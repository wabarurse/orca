import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

test("`parallels version` prints the package.json version", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "version"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toBe(`${pkg.version}\n`);
});

test("REPL uses subscriptions despite API keys and survives invalid login input", async () => {
  const home = await mkdtemp(join(tmpdir(), "parallels-repl-auth-"));
  await mkdir(join(home, "projects", "p", "repo"), { recursive: true });
  await Bun.write(join(home, "claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 },
  }));
  const proc = Bun.spawn([process.execPath, "src/cli.ts", "start", "p"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PARALLELS_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), ANTHROPIC_API_KEY: "test-api-key" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const readOutput = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) output += decoder.decode(chunk, { stream: true });
  })();
  async function waitFor(text: string) {
    const deadline = Date.now() + 3000;
    while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10);
    expect(output).toContain(text);
  }
  async function send(line: string) {
    proc.stdin.write(line + "\n");
    await proc.stdin.flush();
  }
  try {
    await waitFor("/quit");
    await send("/login anthropic personal --from-claude-code");
    await waitFor("now using anthropic:personal");
    expect(output).not.toContain("API billing");
    const config = Bun.TOML.parse(await Bun.file(join(home, "config.toml")).text());
    expect(config).toMatchObject({ account: "personal" });
    const tokens = await Bun.file(join(home, "auth", "anthropic", "personal.json")).json();
    expect(tokens.accessToken).toBe("test-access");
    await send("/accounts");
    await waitFor("Claude Code (Claude subscription)");
    await send("/login codex --api-key");
    await waitFor("usage: /login openai [profile] [--from-codex]");
    expect(output).not.toContain("OpenAI API key");
    await send("/login anthropic ../outside --from-claude-code");
    await waitFor("login failed: Profile must");
    await send("/quit");
    expect(await proc.exited).toBe(0);
    await readOutput;
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(output).not.toContain("test-access");
    expect(output).not.toContain("test-refresh");
  } finally {
    proc.kill();
    await proc.exited;
    await rm(home, { recursive: true, force: true });
  }
});
