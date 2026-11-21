// The tmux runner against a fake `tmux` on PATH (it records argv and answers list commands), the window command run
// for real by /bin/sh, and /mux saving the runner. Never a real tmux server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, paths, saveConfig } from "../../config";
import { createConversation } from "../../core/conversations";
import { registerBuiltins } from "../../core/plugins";
import type { Launch, UiHost } from "../../core/plugins/types";
import background from "./background";
import plugin from "./index";
import { which } from "./launch";
import { socketArgs } from "./runner";
import ui from "./ui";

const FAKE = `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "$TMUX_FAKE/log"; echo >> "$TMUX_FAKE/log"
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
case "$1" in
  has-session) [ -f "$TMUX_FAKE/session" ] ;;
  new-session|new-window) touch "$TMUX_FAKE/session"; echo '%7' ;;
  list-windows) if [ -f "$TMUX_FAKE/broken" ]; then echo 'server exited unexpectedly' >&2; exit 1; fi
    if [ ! -f "$TMUX_FAKE/session" ]; then echo "can't find session: $3" >&2; exit 1; fi
    cat "$TMUX_FAKE/windows" ;;
esac
`;

let fake: string, cwd: string;
const oldPath = process.env.PATH;
const calls = (): string[][] => existsSync(join(fake, "log")) ? readFileSync(join(fake, "log"), "utf8").trim().split("\n").map(l => l.split("\x1f").filter(a => a.length > 0)) : [];
const launch = (argv: string[]): Launch => ({ conversation: "c1", agent: "worker-a", argv, cwd, log: join(fake, "agent.log"),
  env: { PATH: oldPath ?? "/usr/bin:/bin", SECRET: "hunter2 'quoted'", TMUX: "launcher", REX_BLOCK: "block:launcher" } });

beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), "orca2-tmux-fake-"));
  cwd = mkdtempSync(join(tmpdir(), "orca2-tmux-cwd-"));
  writeFileSync(join(fake, "tmux"), FAKE);
  chmodSync(join(fake, "tmux"), 0o755);
  process.env.PATH = `${fake}:${oldPath}`;
  process.env.TMUX_FAKE = fake;
  if (which("tmux") !== join(fake, "tmux")) throw new Error("the fake tmux is not first on PATH");
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(fake, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("start opens the agent's window on orca2's own server, creating the session first, with no secret in argv", async () => {
  const runner = background.runner!;
  expect(await runner.start(launch(["/bin/echo", "hi"]))).toEqual({ handle: "%7", pid: null });
  await runner.start({ ...launch(["/bin/echo", "hi"]), agent: "worker-b" });
  const [has, created, , added] = calls();
  expect(has).toEqual([...socketArgs(), "has-session", "-t", "=orca2-c1"]);
  expect(created!.slice(0, 13)).toEqual([...socketArgs(), "new-session", "-d", "-s", "orca2-c1", "-n", "worker-a", "-c", cwd, "-P", "-F", "#{pane_id}"]);
  expect(added).toContain("new-window");
  expect(added!.slice(added!.indexOf("-t"), added!.indexOf("-t") + 4)).toEqual(["-t", "=orca2-c1:", "-n", "worker-b"]);
  expect(socketArgs()).toEqual(["-S", join(paths.runtime, "tmux.sock")]);
  expect(calls().flat().join(" ")).not.toContain("hunter2");
});

test("the window command sources a private env file that deletes itself, keeps the window's identity and tees to the log", async () => {
  await background.runner!.start(launch(["/bin/sh", "-c", 'echo "secret=$SECRET tmux=${TMUX:-unset} block=${REX_BLOCK:-unset}"']));
  const argv = calls()[1]!;
  const command = argv.slice(argv.indexOf("--") + 1);
  const file = command[4]!;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain("export SECRET='hunter2 '\\''quoted'\\'''");
  expect(readFileSync(file, "utf8")).not.toContain("launcher");
  const proc = Bun.spawn(command, { cwd, env: { TMUX: "pane-own" }, stdout: "pipe" });
  const shown = await new Response(proc.stdout).text();
  expect(shown).toBe("secret=hunter2 'quoted' tmux=pane-own block=unset\n");
  expect(readFileSync(join(fake, "agent.log"), "utf8")).toBe(shown);
  expect(existsSync(file)).toBe(false);
});

test("alive lists window names, [] when the session is gone, null when tmux cannot answer; stop kills that window", async () => {
  const runner = background.runner!;
  expect(await runner.alive("c1")).toEqual([]);
  writeFileSync(join(fake, "session"), "");
  writeFileSync(join(fake, "windows"), "orchestrator\nworker-a\n");
  expect(await runner.alive("c1")).toEqual(["orchestrator", "worker-a"]);
  writeFileSync(join(fake, "broken"), "");
  expect(await runner.alive("c1")).toBeNull();
  await runner.stop("c1", "worker-a");
  expect(calls().at(-1)!.slice(-3)).toEqual(["kill-window", "-t", "=orca2-c1:=worker-a"]);
});

test("/mux offers plain and every enabled runner, and saves the choice as runner", async () => {
  const dir = (name: string): string => join(import.meta.dir, "..", name);
  registerBuiltins([
    { name: "tmux", dir: dir("tmux"), index: () => import("./index"), ui: () => import("./ui"), background: () => import("./background") },
    { name: "rex", dir: dir("rex"), index: () => import("../rex/index"), ui: () => import("../rex/ui"), background: () => import("../rex/background") },
  ]);
  await saveConfig({ plugins: ["tmux", "rex"] });
  const conversation = await createConversation(cwd, "t");
  const notes: string[] = [], picks: string[][] = [];
  const host = { conversation: conversation.id, note: (t: string) => { notes.push(t); },
    pick: (_title: string, options: string[]) => { picks.push(options); return Promise.resolve(1); } } as unknown as UiHost;
  const mux = ui.commands.find(c => c.name === "mux")!;
  await mux.run("rex", host);
  expect((await loadConfig()).runner).toBe("rex");
  await mux.run("", host);
  expect(picks[0]).toEqual(["plain", "rex (current)", "tmux"]);
  expect((await loadConfig()).runner).toBe("rex");
  await mux.run("screen", host);
  expect(notes.at(-1)).toBe("unknown runner screen; choose plain, rex, tmux");
  expect((await loadConfig()).runner).toBe("rex");
  expect(plugin.skills).toEqual(["skills/tmux"]);
});
