import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readState, updateState } from "./state-store";
import { projectStateScope, readProjectState, writeProjectState, paths } from "./paths";
let home: string, previous: string | undefined;
beforeEach(() => { previous = process.env.ORCA_HOME; home = mkdtempSync(join(tmpdir(), "orca-state-")); process.env.ORCA_HOME = home; });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(home, { recursive: true, force: true }); });

test("durable records coexist with archive schemas and survive new processes", async () => {
  const db = new Database(paths.memory);
  db.exec("CREATE TABLE evidence (body TEXT); INSERT INTO evidence VALUES ('retain'); PRAGMA user_version=2"); db.close();
  updateState(paths.memory, "user", "facts", () => [{ key: "tone", text: "concise" }]);
  const script = `import { readState } from ${JSON.stringify(import.meta.dir + "/state-store.ts")}; console.log(JSON.stringify(readState(process.argv[1], 'user', 'facts')));`;
  const child = Bun.spawn([process.execPath, "-e", script, paths.memory], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0); expect(JSON.parse(out)).toEqual([{ key: "tone", text: "concise" }]);
  const verify = new Database(paths.memory, { readonly: true });
  try { expect(verify.query("PRAGMA user_version").get()).toEqual({ user_version: 2 }); expect(verify.query("SELECT body FROM evidence").get()).toEqual({ body: "retain" }); }
  finally { verify.close(); }
  expect(statSync(paths.memory).mode & 0o777).toBe(0o600);
});

test("concurrent processes do not lose updates; failed updates roll back", async () => {
  const script = `import { updateState } from ${JSON.stringify(import.meta.dir + "/state-store.ts")}; for(let n=0;n<25;n++) updateState(process.argv[1], 'user', 'counter', x=>(x??0)+1);`;
  const workers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", script, paths.memory], { stdout: "ignore", stderr: "pipe" }));
  for (const child of workers) { const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect({ code, err }).toEqual({ code: 0, err: "" }); }
  expect(readState(paths.memory, "user", "counter")).toBe(100);
  expect(() => updateState(paths.memory, "user", "counter", () => { throw new Error("abort"); })).toThrow("abort");
  expect(readState(paths.memory, "user", "counter")).toBe(100);
});

test("recreating a project cannot inherit another incarnation's bindings or decisions", () => {
  mkdirSync(paths.project("p"), { recursive: true });
  const prior = projectStateScope("p");
  writeProjectState("p", "repository", { directory: "/previous" });
  writeProjectState("p", "working-context", { goal: "previous goal" });
  rmSync(paths.project("p"), { recursive: true }); Bun.sleepSync(5);
  mkdirSync(paths.project("p"), { recursive: true });
  expect(projectStateScope("p")).not.toBe(prior);
  expect(readProjectState("p", "repository")).toBeUndefined();
  expect(readProjectState("p", "working-context")).toBeUndefined();
  expect(readState(paths.memory, prior, "working-context")).toEqual({ goal: "previous goal" });
});

test("corrupt and symlinked databases are refused without replacement", () => {
  writeFileSync(paths.memory, "original corrupt bytes");
  expect(() => updateState(paths.memory, "user", "key", () => 1)).toThrow();
  expect(readFileSync(paths.memory, "utf8")).toBe("original corrupt bytes");
  rmSync(paths.memory); const external = join(home, "external"); writeFileSync(external, "private"); symlinkSync(external, paths.memory);
  expect(() => readState(paths.memory, "user", "key")).toThrow("unsafe state database");
  expect(readFileSync(external, "utf8")).toBe("private");
});
