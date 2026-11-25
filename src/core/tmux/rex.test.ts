// The Rex backend against a fake `rex` CLI (REX_BIN_DIR points at it): what orca asks Rex, and how it reads the
// answers. Never the real Rex app or server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRexRow, idTime, rexInUse, rexMux, rexPanes } from "./rex";
import { mux } from "./runner";
import { saveConfig } from "../../config";

const SID = "session:01a1fa88-cf9f-715b-9e42-dab8643b9b2d";
const FAKE = `#!/bin/sh
echo "$*" >> "$REX_FAKE/log"
shift
file() { printf '%s' "$REX_FAKE/$1-$(printf '%s' "$2" | tr ':' '_').json"; }
case "$1" in
  ls) if [ -f "$REX_FAKE/down" ]; then echo "Error: no Rex server is running at /x, and autostart is disabled" >&2; exit 4; fi
      if [ "$2" = "-q" ]; then exit 0; fi
      cat "$REX_FAKE/ls.json" 2>/dev/null || echo '{"sessions":[]}' ;;
  new) printf '{"sessions":[{"session_id":"${SID}","label":"%s"}]}' "$2" > "$REX_FAKE/ls.json"; echo '{"session_id":"${SID}"}' ;;
  window) if [ "$2" = ls ]; then f=$(file windows "$4"); if [ -f "$f" ]; then cat "$f"; else echo 'Error: session target not found' >&2; exit 3; fi; fi ;;
  block) if [ "$2" = call ]; then f=$(file process "$4"); if [ -f "$f" ]; then cat "$f"; else echo "Error: block target \\"$4\\" not found" >&2; exit 3; fi; fi ;;
  run) cat "$REX_FAKE/run.json" ;;
  capture) printf 'first\\nlast\\n' ;;
esac
`;

let home: string, fake: string;
const saved: Record<string, string | undefined> = {};
const json = (name: string, id: string, value: unknown) => writeFileSync(join(fake, `${name}-${id.replaceAll(":", "_")}.json`), JSON.stringify(value));
const log = () => existsSync(join(fake, "log")) ? readFileSync(join(fake, "log"), "utf8").trim().split("\n") : [];
const window = (id: string, label: string, blocks: [string, string][]) => ({ window_id: id, label, layers: [{ blocks: blocks.map(([block_id, l]) => ({ block_id, label: l })) }] });
const running = (cwd = "/repo") => ({ last_exit: null, child: { cwd, name: "orca", argv0: "orca" } });

beforeEach(() => {
  for (const key of ["ORCA_HOME", "REX_BIN_DIR", "REX_FAKE"]) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "orca-rex-"));
  fake = mkdtempSync(join(tmpdir(), "orca-rex-cli-"));
  writeFileSync(join(fake, "rex"), FAKE);
  chmodSync(join(fake, "rex"), 0o755);
  Object.assign(process.env, { ORCA_HOME: home, REX_BIN_DIR: fake, REX_FAKE: fake });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(home, { recursive: true, force: true });
  rmSync(fake, { recursive: true, force: true });
});

test("an agent opens as a labelled window in the project's own Rex session, kept open after exit, never starting a server", async () => {
  await rexMux.ensureSession("orca-p", "/repo");
  expect(rexInUse()).toBe(true);
  json("windows", SID, { windows: [window("window:old", "worker-a", [["block:old", "worker-a"]])] });
  json("process", "block:old", { last_exit: { exit_code: 0, error: "" } });
  writeFileSync(join(fake, "run.json"), JSON.stringify({ window_id: "window:new", block_ids: ["block:new"] }));
  expect(await rexMux.openWindow("orca-p", "worker-a", "/wt", ["/bin/sh", "-c", "x"])).toBe("block:new");
  const calls = log();
  expect(calls.every(line => line.startsWith("--autostart=false "))).toBe(true);
  expect(calls).toContain("--autostart=false new orca-p -c /repo --window shell --json");
  expect(calls).toContain("--autostart=false block close block:old"); // the agent's last, finished block
  expect(calls).toContain(`--autostart=false run -s ${SID} --label worker-a -c /wt --keep-open --focus=false --shell=none --json -- /bin/sh -c x`);
  expect(calls).toContain(`--autostart=false window rename -s ${SID} window:new worker-a`);
});

test("a block's program state reads like a tmux pane's: running, exited with a code or a signal, or gone", async () => {
  json("process", "block:r", running());
  json("process", "block:e", { last_exit: { exit_code: 3, error: "exit status 3" } });
  json("process", "block:k", { last_exit: { exit_code: -1, error: "signal: killed" } });
  expect(await mux.pane("block:r")).toEqual({ dead: false, status: null, signal: "" });
  expect(await mux.pane("block:e")).toEqual({ dead: true, status: 3, signal: "" });
  expect(await mux.pane("block:k")).toEqual({ dead: true, status: null, signal: "killed" });
  expect(await mux.pane("block:gone")).toBeNull();
  expect(await mux.capturePane("block:r")).toBe("first\nlast");
});

test("live agents are the orca-labelled blocks still running; a block an agent opened is not one", async () => {
  await rexMux.ensureSession("orca-p", "/repo");
  json("windows", SID, { windows: [window("window:s", "shell", [["block:s", "shell"]]), window("window:a", "worker-a", [["block:a", "worker-a"], ["block:split", "Logs"]]),
    window("window:b", "worker-b", [["block:b", "worker-b"]])] });
  json("process", "block:s", running()); json("process", "block:a", running()); json("process", "block:split", running());
  json("process", "block:b", { last_exit: { exit_code: 0, error: "" } });
  expect(await rexMux.windows("orca-p")).toEqual(["shell", "worker-a"]);
  expect(await rexMux.agentPanes("orca-p")).toEqual([{ name: "shell", live: true }, { name: "worker-a", live: true }, { name: "worker-b", live: false }]);
  expect(await rexMux.windows("orca-other")).toEqual([]);
});

test("Rex is left alone until orca has used it, and a stopped Rex server means nothing runs there", async () => {
  expect(rexInUse()).toBe(false);
  expect(await rexPanes()).toEqual([]);
  expect(log()).toEqual([]);
  await rexMux.ensureSession("orca-p", "/repo");
  writeFileSync(join(fake, "down"), "");
  expect(await rexMux.windows("orca-p")).toEqual([]);
  expect(await rexPanes()).toEqual([]);
});

test("the Processes tab lists blocks agents opened, never orca's own, and closes only those", async () => {
  await rexMux.ensureSession("orca-p", "/repo");
  const other = "session:01a1fa90-0000-7000-8000-000000000000";
  writeFileSync(join(fake, "ls.json"), JSON.stringify({ sessions: [{ session_id: SID, label: "orca-p" }, { session_id: other, label: "stack" }] }));
  json("windows", SID, { windows: [window("window:s", "shell", [["block:s", "shell"]]), window("window:a", "worker-a", [["block:a", "worker-a"], ["block:split", "shell"]])] });
  json("windows", other, { windows: [window("window:o", "web", [["block:o", "shell"]])] });
  for (const b of ["block:s", "block:a", "block:split"]) json("process", b, running());
  json("process", "block:o", running("/repo/web"));
  const panes = await rexPanes();
  expect(panes?.map(p => [p.session, p.pane, p.path])).toEqual([["rex orca-p · worker-a", "block:split", "/repo"], ["rex stack", "block:o", "/repo/web"]]);
  expect(panes?.[1]?.created).toBe(idTime(other));
  await closeRexRow("rex orca-p · worker-a");
  expect(log()).toContain("--autostart=false block close block:split");
  expect(log()).not.toContain("--autostart=false block close block:a");
  await closeRexRow("rex stack");
  expect(log()).toContain(`--autostart=false kill ${other}`);
});

test("new agents start in the multiplexer config.toml names", async () => {
  await saveConfig({ mux: "rex" });
  expect(await mux.selected()).toBe(rexMux);
  await saveConfig({ mux: "tmux" });
  expect(await mux.selected()).not.toBe(rexMux);
});
