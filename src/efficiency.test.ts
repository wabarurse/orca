import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "./orchestrator";
import { paths } from "./config";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { open } from "./transcript";
let home: string;
const before = process.env.ORCA_HOME;
afterEach(async () => { if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before; if (home) await rm(home, { recursive: true, force: true }); });

test("production orchestrator overlaps independent tools, keeps barriers and ordered transcript results", async () => {
  home = await mkdtemp(join(tmpdir(), "efficiency-")); process.env.ORCA_HOME = home;
  await Bun.write(paths.config, 'model = "test"\n');
  let active = 0, peak = 0, entered = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const provider = fakeProvider([
    [toolUse("a", "read", { independent: true }), toolUse("b", "read", { independent: true }), toolUse("c", "write", {}), toolUse("d", "read", {})], [text("Done")],
  ]);
  const orchestrator = await createOrchestrator({ project: "test", provider, write() {}, tools: {
    read: { parallel: input => input.independent === true, spec: { name: "read", input_schema: { type: "object" } }, async run(input) {
      active++; peak = Math.max(peak, active);
      if (input.independent) { if (++entered === 2) release(); await both; }
      active--; return "read";
    } },
    write: { spec: { name: "write", input_schema: { type: "object" } }, async run() { expect(active).toBe(0); expect(entered).toBe(2); return "write"; } },
  } });
  await orchestrator.say("Proceed"); await orchestrator.turn();
  expect(peak).toBe(2);
  const chain = await open(paths.transcript("test", "orchestrator")).chain();
  const results = chain.flatMap(m => typeof m.content === "string" ? [] : m.content).filter(b => b.type === "tool_result");
  expect(results.map(b => b.tool_use_id)).toEqual(["a", "b", "c", "d"]);
});
