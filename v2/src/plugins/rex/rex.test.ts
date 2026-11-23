import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { paths } from "../../config";
import type { Launch } from "../../core/plugins";
import { present } from "../../core/plugins/testing";
import background from "./background";
import plugin from "./index";
import { rexBinary, rexUsed } from "./runner";

const SID = "session:01a1fa88-cf9f-715b-9e42-dab8643b9b2d";
const FAKE = `#!/bin/sh
echo "$*" >> "$REX_FAKE/log"
shift
file() { printf '%s' "$REX_FAKE/$1-$(printf '%s' "$2" | tr ':' '_').json"; }
case "$1" in
  ls) if [ -f "$REX_FAKE/down" ]; then echo "Error: no Rex server is running at /x, and autostart is disabled" >&2; exit 4; fi
      cat "$REX_FAKE/ls.json" 2>/dev/null || echo '{"sessions":[]}' ;;
  new) printf '{"sessions":[{"session_id":"${SID}","label":"%s"}]}' "$2" > "$REX_FAKE/ls.json"; echo '{"session_id":"${SID}"}' ;;
  window) if [ "$2" = ls ]; then f=$(file windows "$4"); if [ -f "$f" ]; then cat "$f"; else echo 'Error: session target not found' >&2; exit 3; fi; fi
          if [ "$2" = new ]; then echo '{"window_id":"window:holder","block_ids":["block:holder"]}'; fi ;;
  block) if [ "$2" = call ]; then f=$(file process "$4"); if [ -f "$f" ]; then cat "$f"; else echo "Error: block target not found" >&2; exit 3; fi; fi ;;
  run) cat "$REX_FAKE/run.json" ;;
  api) if [ "$3" = session.list_blocks ]; then cat "$REX_FAKE/blocks.json"; else echo '{"revision":1}'; fi ;;
esac
`;

let fake: string;
const json = (name: string, id: string, value: unknown): void => writeFileSync(join(fake, `${name}-${id.replaceAll(":", "_")}.json`), JSON.stringify(value));
const log = (): string[] => existsSync(join(fake, "log")) ? readFileSync(join(fake, "log"), "utf8").trim().split("\n") : [];
const window = (id: string, label: string, blocks: [string, string][]): unknown => ({ window_id: id, label, layers: [{ blocks: blocks.map(([block_id, l]) => ({ block_id, label: l })) }] });
const running = { child: { cwd: "/repo", name: "orca2" }, last_exit: null };
const exited = { child: null, last_exit: { exit_code: 0, error: "" } };
const launch: Launch = { conversation: "c1", agent: "worker-a", argv: ["/bin/echo", "hi"], cwd: "/wt", log: "/logs/worker-a.log",
  env: { SECRET: "hunter2", REX_SESSION: "session:launcher", REX_BLOCK: "block:launcher" } };

const runner = present(background.runner, "rex runner");

beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), "orca2-rex-cli-"));
  writeFileSync(join(fake, "rex"), FAKE);
  writeFileSync(join(fake, "blocks.json"), JSON.stringify({ blocks: [] }));
  chmodSync(join(fake, "rex"), 0o755);
  Object.assign(process.env, { REX_BIN_DIR: fake, REX_FAKE: fake });
  rmSync(join(paths.globalData, "rex"), { recursive: true, force: true });
  if (rexBinary() !== join(fake, "rex")) throw new Error("not the fake rex");
});
afterEach(() => { rmSync(fake, { recursive: true, force: true }); });

test("Rex is left alone until orca2 has opened a session there", async () => {
  expect(rexUsed()).toBe(false);
  expect(await runner.alive("c1")).toEqual([]);
  await runner.stop("c1", "worker-a");
  expect(log()).toEqual([]);
});

test("an agent starts hidden (no tab) in the conversation's own session, labelled agent@chat, never starting a server or carrying a secret", async () => {
  writeFileSync(join(fake, "blocks.json"), JSON.stringify({ blocks: [{ block_id: "block:old", label: "worker-a@c1", window_id: null }] }));
  json("process", "block:old", exited);
  writeFileSync(join(fake, "run.json"), JSON.stringify({ window_id: "window:new", block_ids: ["block:new"] }));
  expect(await runner.start(launch)).toEqual({ handle: "block:new", pid: null });
  expect(rexUsed()).toBe(true);
  const calls = log();
  expect(calls.every(line => line.startsWith("--autostart=false "))).toBe(true);
  expect(calls).toContain("--autostart=false new orca2-c1 -c /wt --window shell --json");
  expect(calls).toContain("--autostart=false block close block:old");
  const run = present(calls.find(line => line.includes(" run ")), "rex run call");
  expect(run.startsWith(`--autostart=false run -s ${SID} --label worker-a@c1 -c /wt --keep-open --focus=false --shell=none --json -- /bin/sh -c `)).toBe(true);
  expect(run.endsWith(" /logs/worker-a.log /bin/echo hi")).toBe(true);
  expect(calls).toContain(`--autostart=false api call session.detach_block {"session_id":"${SID}","block_id":"block:new"}`);
  expect(calls.join("\n")).not.toContain("hunter2");
  const file = present(/sh (\S+\.sh) /.exec(run)?.[1], "env file");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const text = readFileSync(file, "utf8");
  expect(text).toContain("export SECRET='hunter2'");
  expect(text).not.toContain("launcher");
});

test("alive is the agent-labelled blocks still running; the idle shell and blocks agents opened are not agents; stop closes the window", async () => {
  writeFileSync(join(fake, "run.json"), JSON.stringify({ window_id: "window:a", block_ids: ["block:a"] }));
  await runner.start(launch);
  json("windows", SID, { windows: [window("window:s", "shell", [["block:s", "shell"]]), window("window:a", "worker-a", [["block:a", "worker-a"], ["block:split", "Logs"]]),
    window("window:b", "worker-b", [["block:b", "worker-b"]])] });
  for (const b of ["block:s", "block:a", "block:split"]) json("process", b, running);
  json("process", "block:b", exited);
  expect(await runner.alive("c1")).toEqual(["worker-a"]);
  expect(await runner.alive("other")).toEqual([]);
  await runner.stop("c1", "worker-a");
  expect(log().at(-1)).toBe(`--autostart=false window close -s ${SID} window:a`);
  writeFileSync(join(fake, "down"), "");
  expect(await runner.alive("c1")).toEqual([]);
  rmSync(join(fake, "down"));
  writeFileSync(join(fake, "ls.json"), "not json");
  expect(await runner.alive("c1")).toBeNull();
});

test("the plugin declares its global marker and has no UI of its own", () => {
  expect(plugin.ui).toBeNull();
  expect(plugin.storage.map(s => s.scope)).toEqual(["global"]);
});

test("when orca2 itself runs in Rex, agents start hidden in its session; attach opens one in its own tab and again hides it; stop closes only that block", async () => {
  const mine = "session:mine";
  mkdirSync(paths.conversation("c1"), { recursive: true });
  writeFileSync(join(paths.conversation("c1"), "viewer.json"), JSON.stringify({ pid: process.pid, rexSession: mine, rexBlock: "block:orca" }));
  writeFileSync(join(fake, "blocks.json"), JSON.stringify({ blocks: [] }));
  writeFileSync(join(fake, "run.json"), JSON.stringify({ window_id: "window:w", block_ids: ["block:w"] }));
  await runner.start(launch);
  const run = present(log().find(line => line.includes(" run ")), "rex run call");
  expect(run.startsWith(`--autostart=false run -s ${mine} --label worker-a@c1 `)).toBe(true);
  expect(log().some(line => line.includes(" new orca2-c1"))).toBe(false);
  expect(log().at(-1)).toBe(`--autostart=false api call session.detach_block {"session_id":"${mine}","block_id":"block:w"}`);

  const hidden = { blocks: [{ block_id: "block:orca", label: "orca2", window_id: "window:orca" }, { block_id: "block:w", label: "worker-a@c1", window_id: null },
    { block_id: "block:o", label: "worker-a@c2", window_id: null }] };
  writeFileSync(join(fake, "blocks.json"), JSON.stringify(hidden));
  for (const b of ["block:orca", "block:w", "block:o"]) json("process", b, running);
  expect(await runner.alive("c1")).toEqual(["worker-a"]);
  expect(await runner.attach("c1", "worker-a")).toEqual({ ok: true, data: { kind: "shown", note: "worker-a is open in its own Rex tab (open it again here to hide it; closing the tab stops it)" } });
  expect(log().slice(-3)).toEqual([
    `--autostart=false api call session.move_block {"session_id":"${mine}","block_id":"block:w","anchor_block_id":"block:holder","direction":"horizontal","side":"after"}`,
    "--autostart=false block close block:holder", `--autostart=false focus -s ${mine} window:holder`]);

  writeFileSync(join(fake, "blocks.json"), JSON.stringify({ blocks: [{ block_id: "block:w", label: "worker-a@c1", window_id: "window:holder" }] }));
  expect(await runner.alive("c1")).toEqual(["worker-a"]);
  expect(await runner.attach("c1", "worker-a")).toEqual({ ok: true, data: { kind: "shown", note: "worker-a is hidden again and keeps running" } });
  expect(log().at(-1)).toBe(`--autostart=false api call session.detach_block {"session_id":"${mine}","block_id":"block:w"}`);

  await runner.stop("c1", "worker-a");
  expect(log()).toContain("--autostart=false block close block:w");
  expect(log().some(line => line.includes("window close"))).toBe(false);
  rmSync(join(paths.conversation("c1"), "viewer.json"));
});
