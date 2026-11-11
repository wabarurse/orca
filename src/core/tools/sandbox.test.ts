import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLayout, paths } from "../../config";
import { sandbox } from "./sandbox";
import { listVerifications, closeVerification, readProcess, liveProcess, verificationPaths, reconcileVerifications } from "../data/processes";
import { saveVerification } from "../data/processes/verification-store";
import { execution } from "../data/projects/lifecycle";
import { png } from "../../test/image-fixture";
import type { ToolContext } from "./registry";

let home: string, cwd: string, ctx: ToolContext, previous: string | undefined, previousPath: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME; previousPath = process.env.PATH;
  home = await mkdtemp(join(tmpdir(), "orca-verification-test-")); process.env.ORCA_HOME = home;
  assertLayout(home);
  await mkdir(paths.project("p"), { recursive: true });
  cwd = join(home, "source"); await mkdir(cwd);
  git("init", "-q");
  await writeFile(join(cwd, "app.txt"), "original\n");
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await writeFile(join(cwd, "shot.png"), png());
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  ctx = { project: "p", role: "worker", branch: "work", run: "one", cwd };
});
afterEach(async () => {
  for (const v of await listVerifications("p")) await closeVerification("p", v.id).catch(() => {});
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  process.env.PATH = previousPath;
  await rm(home, { recursive: true, force: true });
});
function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
async function settled(id: string) {
  for (let n = 0; n < 160; n++) {
    const p = await readProcess("p", id);
    if (!liveProcess(p) && p.events.every(e => e.delivered)) return p;
    await Bun.sleep(25);
  }
  throw new Error("process did not settle");
}
const call = async (input: Record<string, unknown>) => JSON.parse(await sandbox.run(input, ctx));

test("ordinary directory sandbox needs no Git and retains results while preserving the source", async () => {
  await rm(join(cwd, ".git"), { recursive: true });
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "node_modules/ignored"), "rebuildable");
  process.env.PATH = "";
  try {
    const v = await call({ action: "create", backend: "local" });
    expect(await readFile(join(v.workspace, "app.txt"), "utf8")).toBe("original\n");
    expect(await Bun.file(join(v.workspace, "node_modules/ignored")).exists()).toBe(false);
    await writeFile(join(v.workspace, "app.txt"), "sandbox edit\n");
    expect((await call({ action: "close", id: v.id })).state).toBe("closed");
    expect(await readFile(join(v.evidence, "directory-result/app.txt"), "utf8")).toBe("sandbox edit\n");
    expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("original\n");
    expect(await Bun.file(join(cwd, ".git/HEAD")).exists()).toBe(false);
    expect(await Bun.file(join(v.workspace, "app.txt")).exists()).toBe(false);
  } finally { process.env.PATH = previousPath; }
});

test("directory snapshot refuses symlinks and rolls back only its owned workspace", async () => {
  await rm(join(cwd, ".git"), { recursive: true });
  const outside = join(home, "private.txt"); await writeFile(outside, "keep private");
  await symlink(outside, join(cwd, "linked.txt"));
  await expect(call({ action: "create", backend: "local" })).rejects.toThrow("links or special files");
  const records = await listVerifications("p");
  expect(records).toHaveLength(1);
  expect(records[0]!.state).toBe("closed");
  expect(await readFile(outside, "utf8")).toBe("keep private");
  expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("original\n");
});

test("snapshot includes current edits and untracked files; checks and capture keep evidence after cleanup", async () => {
  await writeFile(join(cwd, "app.txt"), "current edit\n");
  await mkdir(join(cwd, "new")); await writeFile(join(cwd, "new/file.txt"), "untracked\n");
  const v = await call({ action: "create", backend: "local" });
  expect(await readFile(join(v.workspace, "app.txt"), "utf8")).toBe("current edit\n");
  expect(await readFile(join(v.workspace, "new/file.txt"), "utf8")).toBe("untracked\n");
  const check = await call({ action: "run", id: v.id, command: 'printf "{\"ok\":true}" > "$ORCA_ARTIFACTS/api.json"; printf "checked"' });
  expect((await settled(check.process)).exitCode).toBe(0);
  const capture = await call({ action: "capture", id: v.id, filename: "after.png", command: 'cp shot.png "$ORCA_CAPTURE_PATH"' });
  expect((await settled(capture.process)).exitCode).toBe(0);
  const closed = await call({ action: "close", id: v.id });
  expect(closed.state).toBe("closed");
  expect(await Bun.file(join(v.workspace, "app.txt")).exists()).toBe(false);
  expect(Buffer.from(await Bun.file(join(v.evidence, "after.png")).arrayBuffer()).toString("hex")).toBe(png().toString("hex"));
  expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("current edit\n");
  expect((await call({ action: "close", id: v.id })).state).toBe("closed");
});

test("closing stops owned local apps and refuses launching more commands", async () => {
  const v = await call({ action: "create", backend: "local" });
  const p = await call({ action: "run", id: v.id, command: "sleep 30" });
  await Bun.sleep(250);
  expect((await call({ action: "close", id: v.id })).state).toBe("closed");
  expect(liveProcess(await readProcess("p", p.process))).toBe(false);
  await expect(sandbox.run({ action: "run", id: v.id, command: "touch should-not-run" }, ctx)).rejects.toThrow("no longer active");
});

test("conversation stop cleans an owned session and another run cannot control it", async () => {
  const v = await call({ action: "create", backend: "local" });
  await expect(sandbox.run({ action: "close", id: v.id }, { ...ctx, run: "other" })).rejects.toThrow("another agent run");
  await execution.stop("p");
  await reconcileVerifications("p");
  const data = await listVerifications("p");
  expect(data[0]?.state).toBe("closed");
  expect(await Bun.file(join(v.workspace, "app.txt")).exists()).toBe(false);
});

test("expiry removes scratch while workspace-owned evidence waits for explicit cleanup", async () => {
  const v = await call({ action: "create", backend: "local" });
  await saveVerification({ ...v, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await reconcileVerifications("p", undefined, undefined, true);
  const [closed] = await listVerifications("p");
  expect(closed?.state).toBe("closed");
  await saveVerification({ ...closed!, createdAt: "2026-01-01T00:00:00Z" });
  await reconcileVerifications("p", undefined, undefined, true);
  expect(await listVerifications("p")).toHaveLength(1);
  expect(await Bun.file(join(v.evidence, "source.json")).exists()).toBe(true);
});

test("capture success requires evidence and a recording can finalize on close", async () => {
  const v = await call({ action: "create", backend: "local" });
  const missing = await call({ action: "capture", id: v.id, filename: "missing.png", command: "true" });
  expect((await settled(missing.process)).reason).toBe("capture produced no evidence");
  const recording = await call({ action: "capture", id: v.id, filename: "recording.mov", seconds: 120,
    command: 'trap \'printf finalized > "$ORCA_CAPTURE_PATH"; exit 0\' INT; while :; do sleep 0.1; done' });
  for (let n = 0; n < 40; n++) {
    if ((await readProcess("p", recording.process)).state === "running") break;
    await Bun.sleep(25);
  }
  await Bun.sleep(100);
  expect((await call({ action: "close", id: v.id })).state).toBe("closed");
  expect(await readFile(join(v.evidence, "recording.mov"), "utf8")).toBe("finalized");
});

async function fakeBinary(name: string, script: string) {
  const dir = join(home, "bin"); await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`); await chmod(path, 0o700);
  process.env.PATH = `${dir}:${previousPath}`;
}
test("container lifecycle uses labels and removes only the container matched by ownership", async () => {
  const log = join(home, "docker.log");
  await fakeBinary("docker", `printf '%s\\n' "$*" >> '${log}'\ncase "$1" in ps) echo abcdef;; esac`);
  const v = await call({ action: "create", backend: "docker", image: "fixture:local", ports: [3000] });
  expect((await call({ action: "close", id: v.id })).state).toBe("closed");
  const commands = await readFile(log, "utf8");
  expect(commands).toContain(`--label orca.verification=${v.id}`);
  expect(commands).toContain("127.0.0.1::3000");
  expect(commands).toContain(`--filter label=orca.identity=${v.identity}`);
  expect(commands).toContain("rm -fv abcdef");
  expect(commands).not.toContain("prune");
});

test("partial container provisioning failure retains retryable cleanup state", async () => {
  await fakeBinary("docker", "exit 1");
  await expect(sandbox.run({ action: "create", backend: "docker", image: "fixture:local" }, ctx)).rejects.toThrow("failed");
  const [v] = await listVerifications("p");
  expect(v?.state).toBe("cleanup_failed");
  expect(v?.errors?.join(" ")).toContain("Docker ownership");
  await fakeBinary("docker", "exit 0");
  expect((await closeVerification("p", v!.id)).state).toBe("closed");
});

if (process.platform === "darwin") test("iOS uses a private device set for creation, capture and disposal", async () => {
  const log = join(home, "simctl.log");
  await fakeBinary("xcrun", `printf '%s\\n' "$*" >> '${log}'\nif [ "$4" = create ]; then touch "$3/device_set.plist"; echo 11111111-1111-4111-8111-111111111111; fi\nif [ "$4" = io ]; then printf capture > "$7"; fi`);
  const v = await call({ action: "create", backend: "local", simulator: { deviceType: "fixture-device", runtime: "fixture-runtime" } });
  const capture = await call({ action: "capture", id: v.id, target: "ios", filename: "ios.png" });
  expect((await settled(capture.process)).exitCode).toBe(0);
  expect((await call({ action: "close", id: v.id })).state).toBe("closed");
  const commands = await readFile(log, "utf8");
  const devices = verificationPaths("p", v.id).devices;
  expect(commands).toContain(`--set ${devices} create`);
  expect(commands).toContain(`--set ${devices} shutdown all`);
  expect(commands).toContain(`--set ${devices} delete all`);
  expect(await Bun.file(join(v.evidence, "ios.png")).exists()).toBe(true);
});
