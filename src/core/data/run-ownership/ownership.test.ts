import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config";
import { projectIdentity } from "../projects/state";
import { acquireRunOwnership as acquire, requestRunStop, releaseRunOwnership as release, type RunOwner, type TerminationEvidence } from "./ownership";

const home = mkdtempSync(join(tmpdir(), "run-ownership-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
let n = 0, owner: RunOwner;
beforeEach(() => {
  const project = `ownership-${n++}`; mkdirSync(paths.project(project), { recursive: true });
  owner = { project, incarnation: projectIdentity(project), branch: "feat/a-b", task: crypto.randomUUID(), run: crypto.randomUUID(), agent: "worker-a-b", role: "worker", supervisor: { host: "host", boot: "boot", pid: 123, birth: "os-birth-token" } };
});
const next = (): RunOwner => ({ ...owner, run: crypto.randomUUID(), role: "reviewer" });
const proof = (o = owner): TerminationEvidence => ({ owner: o, supervisor: "exited", descendants: "gone", containment: "sealed" });
const ledger = () => join(paths.root, "run-ownership", `${owner.project}.json`);

test("concurrent worker/reviewer admission has exactly one winner; exact retry is idempotent", async () => {
  const contenders = [owner, ...Array.from({ length: 15 }, next)];
  const results = await Promise.all(contenders.map(o => acquire(o, "verified-clear")));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await acquire(contenders[results.indexOf(true)]!, "unknown")).toBe(true);
  expect(JSON.parse(readFileSync(ledger(), "utf8")).records).toHaveLength(1);
});

test("unknown inventory fails closed; distinct full branches do not collide by slug", async () => {
  expect(await acquire(owner, "unknown")).toBe(false);
  expect(await acquire(owner, "verified-clear")).toBe(true);
  expect(await acquire({ ...next(), branch: "feat/a/b" }, "verified-clear")).toBe(true);
});

test("stop intent, parent exit and unknown/escaped children retain ownership", async () => {
  await acquire(owner, "verified-clear");
  expect(await requestRunStop(owner)).toBe(true);
  for (const patch of [{ supervisor: "unknown" }, { descendants: "alive" }, { descendants: "unknown" }, { containment: "unknown" }] as Partial<TerminationEvidence>[]) {
    expect(await release(owner, { ...proof(), ...patch })).toBe(false);
    expect(await acquire(next(), "verified-clear")).toBe(false);
  }
  expect(JSON.parse(readFileSync(ledger(), "utf8")).records[0].state).toBe("stopping");
});

test("release/admission race is serialized; stale release and stop cannot mutate successor", async () => {
  await acquire(owner, "verified-clear"); const successor = next();
  expect(await Promise.all([release(owner, proof()), acquire(successor, "verified-clear")])).toEqual([true, true]);
  const bytes = readFileSync(ledger(), "utf8");
  expect(await release(owner, proof())).toBe(true);
  expect(await requestRunStop(owner)).toBe(false);
  expect(await acquire(owner, "verified-clear")).toBe(false);
  expect(await acquire(next(), "verified-clear")).toBe(false);
  expect(readFileSync(ledger(), "utf8")).toBe(bytes);
});

test("every identity component including process birth is bound to release", async () => {
  await acquire(owner, "verified-clear");
  for (const changed of [{ ...owner, task: "other" }, { ...owner, agent: "other" }, next(), { ...owner, branch: "other" }, { ...owner, supervisor: { ...owner.supervisor, birth: "reused-pid" } }, { ...owner, incarnation: "other" }, { ...owner, project: "other" }]) {
    expect(await release(owner, proof(changed))).toBe(false);
  }
  expect(await acquire(next(), "verified-clear")).toBe(false);
});

test("project recreation preserves old ledger and rejects old and new incarnation", async () => {
  await acquire(owner, "verified-clear");
  renameSync(paths.project(owner.project), `${paths.project(owner.project)}-old`);
  mkdirSync(paths.project(owner.project));
  await expect(release(owner, proof())).rejects.toThrow("project changed");
  await expect(acquire({ ...next(), incarnation: projectIdentity(owner.project) }, "verified-clear")).rejects.toThrow("recovery required");
});

test("corrupt persisted evidence is not overwritten or considered free", async () => {
  await acquire(owner, "verified-clear");
  writeFileSync(ledger(), '{"version":99}');
  await expect(acquire(next(), "verified-clear")).rejects.toThrow("recovery required");
  expect(readFileSync(ledger(), "utf8")).toBe('{"version":99}');
});

test("independent processes contend through the persistent project lock", async () => {
  const module = new URL("./ownership.ts", import.meta.url).href;
  const children = [owner, next(), next(), next()].map(o => Bun.spawn([process.execPath, "--eval", `import { acquireRunOwnership } from ${JSON.stringify(module)}; console.log(await acquireRunOwnership(${JSON.stringify(o)}, "verified-clear"));`], { env: { ...process.env, ORCA_HOME: home }, stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => {
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: "" });
    return output.trim();
  }));
  expect(results.filter(r => r === "true")).toHaveLength(1);
  expect(results.filter(r => r === "false")).toHaveLength(3);
});
