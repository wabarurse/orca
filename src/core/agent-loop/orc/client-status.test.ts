import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, saveConfig } from "../../../config";
import type { DaemonStatus, LiveEvent } from "../../../protocol";
import { createClientOrchestrator } from "./client";
import { liveFile } from "./live";

const previous = process.env.ORCA_HOME;
let home: string;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("attaching mid-turn restores text and tools but only new status events display, once per client", async () => {
  home = mkdtempSync(join(tmpdir(), "orca-client-status-"));
  process.env.ORCA_HOME = home;
  await saveConfig({ model: "fake-model" });
  const project = "status";
  mkdirSync(paths.orchestrator(project), { recursive: true });
  const state: DaemonStatus = { pid: process.pid, run: "run", state: "turn", since: "", turns: 1 };
  const initial: LiveEvent[] = [
    { kind: "start", seq: 0, run: "run", turn: 1, at: "" },
    { kind: "status", seq: 1, head: null, text: "old request feedback" },
    { kind: "text", seq: 2, head: null, text: "partial reply" },
    { kind: "tool_start", seq: 3, head: null, call: { id: "t", name: "bash", input: {} } },
  ];
  writeFileSync(liveFile(project), initial.map(event => JSON.stringify(event) + "\n").join(""));
  const create = async () => {
    const notices: string[] = [], text: string[] = [], tools: string[] = [];
    const client = await createClientOrchestrator({ project, status: async () => state, followMs: 10, liveMs: 5,
      notice: value => notices.push(value), write: value => text.push(value), onTool: call => tools.push(call.id) });
    const following = client.turn();
    return { client, following, notices, text, tools };
  };
  const a = await create();
  let b: Awaited<ReturnType<typeof create>> | undefined;
  try {
    await until(() => a.tools.includes("t"));
    expect(a.text).toEqual(["partial reply"]);
    expect(a.notices).toEqual([]);
    appendFileSync(liveFile(project), JSON.stringify({ kind: "status", seq: 4, head: null, text: "new feedback" }) + "\n");
    await until(() => a.notices.length === 1);
    expect(a.notices).toEqual(["new feedback"]);
    b = await create(); // Another attachment must not replay either status.
    await until(() => b!.tools.includes("t"));
    expect(b.notices).toEqual([]);
    expect(b.text).toEqual(["partial reply"]);
    appendFileSync(liveFile(project), JSON.stringify({ kind: "status", seq: 5, head: null, text: "fresh feedback" }) + "\n");
    await until(() => b!.notices.length === 1);
    await Bun.sleep(30);
    expect(a.notices).toEqual(["new feedback", "fresh feedback"]);
    expect(b.notices).toEqual(["fresh feedback"]);
  } finally {
    state.state = "idle";
    a.client.dispose?.(); b?.client.dispose?.();
    await Promise.all([a.following, b?.following]);
  }
});
