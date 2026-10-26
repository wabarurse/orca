import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchEnvironment } from "./launch-environment";
import { paths } from "../../config/config";

let home: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.ORCA_HOME;
  home = mkdtempSync(join(tmpdir(), "orca-env-"));
  process.env.ORCA_HOME = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("agent gets current generic logins, home, path and sockets instead of stale tmux state; secrets never enter argv", async () => {
  const secret = "fake'login\n$(touch SHOULD_NOT_EXIST) `literal` $HOME";
  const env = { HOME: "/current/home", PATH: "/current/bin", XDG_CONFIG_HOME: "/current/config", SSH_AUTH_SOCK: "/current/socket", CLOUD_TOKEN: secret };
  const launch = await launchEnvironment("p", [process.execPath, "-e", "console.log(JSON.stringify(process.env))"], env);
  expect(JSON.stringify(launch.argv)).not.toContain(secret);
  const directory = join(paths.project("p"), "launches", readdirSync(join(paths.project("p"), "launches"))[0]!);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, "launch.sh")).mode & 0o777).toBe(0o600);
  const child = Bun.spawn(launch.argv, { cwd: home, env: { PATH: "/stale", HOME: "/stale", STALE_TOKEN: "old", CLOUD_TOKEN: "old", TMUX: "window-session", TMUX_PANE: "%17" }, stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(output).toMatchObject({ ...env, TMUX: "window-session", TMUX_PANE: "%17" });
  expect(output.STALE_TOKEN).toBeUndefined();
  expect(existsSync(join(home, "SHOULD_NOT_EXIST"))).toBe(false);
  expect(existsSync(directory)).toBe(false);
});

test("failed window creation can discard its private environment handoff", async () => {
  const launch = await launchEnvironment("p", ["unused"], { LOGIN: "fake" });
  await launch.cleanup();
  expect(readdirSync(join(paths.project("p"), "launches"))).toEqual([]);
});
