import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withGitCredentials } from "./git-credentials";
import { HARNESS_ORIGIN, pullHarness, updateCommand } from "./pull";
import { pullFixture } from "../../test/pull-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const configQuote = (s: string) => JSON.stringify(s);
const helper = (name: string) => `!f() { printf 'username=${name}\\npassword=fake-password\\n'; }; f`;

async function credentials(cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([Bun.which("git")!, "credential", "fill"], { cwd, env, stdin: new Blob(["protocol=https\nhost=github.com\n\n"]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  expect({ code: await child.exited, err }).toEqual({ code: 0, err: "" });
  return out;
}

for (const fail of [false, true]) {
  test(`updater uses included global credential helpers without importing rewrites/hooks; cleans private config after ${fail ? "failure" : "success"}`, async () => {
    const f = await pullFixture(); roots.push(f.root);
    await writeFile(join(f.home, ".gitconfig"), `[include]\n path = auth.inc\n[url "${f.remote}"]\n insteadOf = https://github.com/\n[core]\n hooksPath = /unsafe/hooks\n`);
    await writeFile(join(f.home, "auth.inc"), `[credential "https://github.com"]\n helper = ${configQuote(helper("fixture-user"))}\n useHttpPath = true\n`);
    let temporary = "";
    const operation = pullHarness({ ...f.options, command: async (argv, cwd, env) => {
      if (argv.includes("fetch")) {
        temporary = env.GIT_CONFIG_GLOBAL!;
        expect(statSync(temporary).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(temporary)).mode & 0o777).toBe(0o700);
        expect(await readFile(temporary, "utf8")).not.toMatch(/insteadOf|hooksPath|include/i);
        expect(argv.join(" ")).not.toContain("fake-password");
        expect(await credentials(cwd, env)).toContain("username=fixture-user");
        expect((await updateCommand([Bun.which("git")!, "remote", "get-url", "origin"], cwd, env)).out.trim()).toBe(HARNESS_ORIGIN);
        if (fail) return { code: 128, out: "", err: "fixture fetch failure" };
      }
      return f.command(argv, cwd, env);
    } });
    if (fail) await expect(operation).rejects.toThrow("fixture fetch failure"); else await operation;
    expect(temporary).not.toBe("");
    expect(existsSync(dirname(temporary))).toBe(false);
    expect(await f.binary()).toBe(fail ? "old executable" : "new executable");
  });
}

test.each(["system", "unknown"])("%s scope and global helper order, empty resets, scoped settings and local precedence survive", async scope => {
  const f = await pullFixture(); roots.push(f.root);
  const output = [
    scope, `credential.helper\n${helper("system-user")}`,
    "global", "credential.helper\n",
    "global", `credential.helper\n${helper("global-user")}`,
    "global", 'credential.https://unused.invalid.username\nglobal username "quoted"\t#literal\nsecond line\\slash',
    "global", "credential.usehttppath\ntrue",
    "local", `credential.helper\n${helper("must-not-copy")}`,
    "global", 'url.https://elsewhere.invalid/.insteadof\nhttps://github.com/',
    "global", "core.hookspath\n/unsafe/hooks",
  ].join("\0") + "\0";
  const env = { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  await withGitCredentials(Bun.which("git")!, f.app, env, async () => ({ code: 0, out: output, err: "" }), async env => {
    const text = await readFile(env.GIT_CONFIG_GLOBAL!, "utf8");
    expect(text).not.toContain("must-not-copy");
    const settings = await updateCommand([Bun.which("git")!, "config", "--global", "--null", "--get-all", "credential.helper"], f.app, env);
    expect(settings.out.split("\0")).toEqual([helper("system-user"), "", helper("global-user"), ""]);
    const username = await updateCommand([Bun.which("git")!, "config", "--global", "--get", "credential.https://unused.invalid.username"], f.app, env);
    expect(username.out).toBe('global username "quoted"\t#literal\nsecond line\\slash\n');
    expect((await updateCommand([Bun.which("git")!, "config", "--bool", "--get", "credential.usehttppath"], f.app, env)).out).toBe("true\n");
    expect(await credentials(f.app, env)).toContain("username=global-user");
    await f.g(f.app, "config", "--add", "credential.helper", "");
    await f.g(f.app, "config", "--add", "credential.helper", helper("local-user"));
    expect(await credentials(f.app, env)).toContain("username=local-user");
  });
});

test("no credential config needs no temporary file; configuration errors do not echo secret output", async () => {
  const env = { GIT_CONFIG_GLOBAL: "/dev/null" };
  const command = async () => ({ code: 0, out: "global\0core.hookspath\n/ignored\0", err: "" });
  await withGitCredentials("git", "/unused", env, command, async actual => { expect(actual).toBe(env); });
  let called = false;
  await expect(withGitCredentials("git", "/unused", env, async () => ({ code: 1, out: "SECRET", err: "SECRET" }), async () => { called = true; })).rejects.toThrow("could not read git credential configuration");
  expect(called).toBe(false);
});
