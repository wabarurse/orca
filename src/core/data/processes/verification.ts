import { cp, mkdir, realpath, rm, writeFile, lstat, readdir, appendFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pidAlive, withStorageLock } from "../storage-lock";
import { run } from "../../proc";
import { projectIdentity } from "../projects";
import { execution } from "../projects/lifecycle";
import { liveProcess, listProcesses } from "./store";
import { checkoutHere } from "../projects/workspace";
import { copyDirectorySnapshot } from "./directory-snapshot";
import { controlProcess } from "./supervisor";
import { listVerifications, readVerification, saveVerification, verificationLock, verificationPaths, type Verification } from "./verification-store";

export async function verificationCommand(argv: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await run(argv, { cwd, signal, timeoutMs: 60_000 });
  if (!result || result.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${result?.err.slice(-1000) ?? "unavailable or timed out"}`);
  return result.out;
}
export const containerName = (v: Verification) => `orca-verify-${v.id}`;

async function snapshot(v: Verification, signal?: AbortSignal) {
  const { workspace, evidence } = verificationPaths(v.project, v.id);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  if (!await checkoutHere(v.source)) {
    await copyDirectorySnapshot(v.source, workspace, signal);
    await mkdir(join(workspace, ".orca-tmp"), { mode: 0o700 });
    await writeFile(join(evidence, "source.json"), JSON.stringify({ source: v.source, kind: "directory" }) + "\n", { mode: 0o600 });
    return;
  }
  await verificationCommand(["git", "clone", "--shared", "--no-hardlinks", "--no-checkout", "--", v.source, workspace], v.source, signal);
  v.objects = join((await verificationCommand(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], v.source)).trim(), "objects");
  await saveVerification(v);
  const head = await verificationCommand(["git", "rev-parse", "HEAD"], v.source, signal).then(out => out.trim());
  await verificationCommand(["git", "checkout", "--detach", head], workspace, signal);
  const patch = await verificationCommand(["git", "diff", "--binary", "HEAD"], v.source, signal);
  if (patch) {
    const file = join(evidence, "input.patch");
    await writeFile(file, patch + "\n", { mode: 0o600 });
    await verificationCommand(["git", "apply", "--", file], workspace, signal);
  }
  const untracked = await verificationCommand(["git", "ls-files", "--others", "--exclude-standard", "-z"], v.source, signal);
  let untrackedBytes = 0;
  for (const file of untracked.split("\0").filter(Boolean)) {
    const source = await realpath(join(v.source, file));
    if (relative(v.source, source).startsWith("..")) throw new Error("untracked file escapes source checkout");
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    untrackedBytes += (await lstat(source)).size;
    if (untrackedBytes > 32 * 1024 * 1024) throw new Error("untracked source exceeds 32 MiB; exclude generated files before creating a session");
    await cp(source, join(workspace, file), { recursive: false, force: false, errorOnExist: true });
  }
  await mkdir(join(workspace, ".orca-tmp"), { mode: 0o700 });
  await appendFile(join(workspace, ".git", "info", "exclude"), "\n/.orca-tmp/\n");
  await writeFile(join(evidence, "source.json"), JSON.stringify({ source: v.source, head }) + "\n", { mode: 0o600 });
}

export async function createVerification(input: Omit<Verification, "id" | "identity" | "createdAt" | "state" | "source"> & { source: string }, signal?: AbortSignal): Promise<Verification> {
  signal?.throwIfAborted();
  execution.assertActive(input.project, input.epoch);
  const source = await checkoutHere(input.source) ?? await realpath(input.source);
  const v: Verification = { ...input, simulator: input.simulator ? { ...input.simulator } : undefined, source, id: crypto.randomUUID(),
    identity: projectIdentity(input.project), createdAt: new Date().toISOString(), state: "creating" };
  await withStorageLock(join(verificationPaths(v.project, v.id).root, "..", "admission.lock"), async () => {
    if ((await listVerifications(v.project)).filter(s => s.state !== "closed").length >= 4) throw new Error("close an existing verification session before creating another");
    await saveVerification(v); // Ownership is durable before provisioning.
  });
  try {
    await verificationLock(v.project, v.id, async () => {
      await snapshot(v, signal);
      execution.assertActive(v.project, v.epoch);
      const { workspace, evidence, devices } = verificationPaths(v.project, v.id);
      if (v.backend === "docker") {
        const mountWorkspace = await realpath(workspace), mountEvidence = await realpath(evidence);
        if ([mountWorkspace, mountEvidence, v.objects ?? ""].some(path => path.includes(","))) throw new Error("Docker bind paths cannot contain commas");
        if (!v.image || v.image.startsWith("-")) throw new Error("docker image is required");
        await verificationCommand(["docker", "create", "--pull=never", "--name", containerName(v),
          "--label", `orca.verification=${v.id}`, "--label", `orca.identity=${v.identity}`,
          "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--init",
          ...[mountWorkspace, mountEvidence].flatMap((dir, i) => ["--mount", `type=bind,src=${dir},dst=${i ? "/artifacts" : "/workspace"}`]),
          ...(v.objects ? ["--mount", `type=bind,src=${v.objects},dst=${v.objects},readonly`] : []),
          ...[...(v.ports ?? [])].flatMap(port => ["-p", `127.0.0.1::${port}`]),
          "-w", "/workspace", "-e", "ORCA_ARTIFACTS=/artifacts", "--entrypoint", "sh", v.image,
          "-c", "while :; do sleep 3600; done"], workspace, signal);
        await verificationCommand(["docker", "start", containerName(v)], workspace, signal);
        if (v.ports?.length) v.publishedPorts = (await verificationCommand(["docker", "port", containerName(v)], workspace)).trim();
      }
      if (v.simulator) {
        if (v.backend !== "local" || process.platform !== "darwin") throw new Error("iOS requires a local macOS verification session");
        await mkdir(devices, { recursive: true, mode: 0o700 });
        v.simulator.device = await verificationCommand(["xcrun", "simctl", "--set", devices, "create", containerName(v), v.simulator.deviceType, v.simulator.runtime], workspace, signal).then(out => out.trim());
        await saveVerification(v);
        await verificationCommand(["xcrun", "simctl", "--set", devices, "boot", v.simulator.device!], workspace, signal);
      }
      v.state = "active";
      await saveVerification(v);
    });
    return v;
  } catch (error) {
    const cleaned = await closeVerification(v.project, v.id).catch(() => undefined);
    if (cleaned?.state !== "closed") throw new Error(`${error}; verification ${v.id} cleanup is incomplete; inspect and retry close`);
    throw error;
  }
}

export async function closeVerification(project: string, id: string): Promise<Verification> {
  return verificationLock(project, id, async () => {
    const v = await readVerification(project, id);
    if (v.state === "closed") return v;
    v.state = "closing";
    await saveVerification(v);
    const errors: string[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (e) { errors.push(String(e)); } };
    const { root, workspace, devices, evidence } = verificationPaths(project, id);
    const processes = (await listProcesses(project)).filter(p => p.verification === id && (liveProcess(p) || p.state === "unknown"));
    for (const p of processes) if (liveProcess(p)) await attempt(() => controlProcess(project, p.id, "stop"));
    for (let i = 0; i < 40 && processes.length; i++) {
      const remaining = (await listProcesses(project)).filter(p => p.verification === id && (liveProcess(p) || p.state === "unknown"));
      if (!remaining.length) break;
      await Bun.sleep(100);
      if (i === 39) errors.push("verification commands have not stopped; retaining workspace");
    }
    if (v.backend === "docker") await attempt(async () => {
      const found = await run(["docker", "ps", "-aq", "--filter", `name=^/${containerName(v)}$`, "--filter", `label=orca.verification=${id}`, "--filter", `label=orca.identity=${v.identity}`], { cwd: root, timeoutMs: 15_000 });
      if (!found || found.code !== 0) throw new Error("cannot verify Docker ownership");
      for (const container of found.out.split(/\s+/).filter(Boolean)) await verificationCommand(["docker", "rm", "-fv", container], root);
    });
    if (v.simulator) await attempt(async () => {
      // This is a private device set. Its devices cannot refer to the user's normal simulator set.
      if (await Bun.file(join(devices, "device_set.plist")).exists()) {
        if ((await lstat(devices)).isSymbolicLink() || await realpath(devices) !== join(await realpath(root), "devices")) throw new Error("private simulator path changed; retaining session");
        await verificationCommand(["xcrun", "simctl", "--set", devices, "shutdown", "all"], root);
        await verificationCommand(["xcrun", "simctl", "--set", devices, "delete", "all"], root);
      }
    });
    if (!errors.length) {
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      // Preserve edits made during verification before disposing its checkout.
      await attempt(async () => {
        if (await lstat(workspace).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) {
          if ((await lstat(workspace)).isSymbolicLink() || await realpath(workspace) !== join(await realpath(root), "workspace")) throw new Error("verification workspace path changed");
          const metadata = await Bun.file(join(evidence, "source.json")).json().catch(() => undefined);
          if (metadata?.kind === "directory") {
            // Keep the full small source result, including deletions, before removing scratch.
            const result = join(evidence, "directory-result");
            await rm(result, { recursive: true, force: true });
            await copyDirectorySnapshot(workspace, result);
          }
        }
        if (await Bun.file(join(workspace, ".git", "HEAD")).exists()) {
          if ((await lstat(workspace)).isSymbolicLink() || await realpath(workspace) !== join(await realpath(root), "workspace")) throw new Error("verification workspace path changed");
          const patch = await verificationCommand(["git", "diff", "--binary", "HEAD"], workspace);
          await writeFile(join(evidence, "result.patch"), patch + "\n", { mode: 0o600 });
          const untracked = await verificationCommand(["git", "ls-files", "--others", "--exclude-standard", "-z"], workspace);
          for (const file of untracked.split("\0").filter(Boolean)) {
            const from = await realpath(join(workspace, file));
            if (relative(await realpath(workspace), from).startsWith("..") || (await lstat(from)).size > 32 * 1024 * 1024) {
              throw new Error("untracked verification output cannot be archived safely; session retained for inspection");
            }
            const target = join(evidence, "untracked", file);
            await mkdir(dirname(target), { recursive: true });
            await cp(from, target, { force: true });
          }
        }
        await rm(workspace, { recursive: true, force: true });
        await rm(devices, { recursive: true, force: true });
      });
    }
    v.errors = errors;
    v.state = errors.length ? "cleanup_failed" : "closed";
    await saveVerification(v);
    return v;
  });
}

const swept = new Map<string, { at: number; epoch: string }>();
export async function reconcileVerifications(project: string, owner?: string, runId?: string, force = false): Promise<void> {
  const previous = swept.get(project), epoch = execution.epoch(project);
  if (!force && !owner && !execution.stopped(project) && previous?.epoch === epoch && Date.now() - previous.at < 30_000) return;
  swept.set(project, { at: Date.now(), epoch });
  await pruneVerificationEvidence(project);
  for (const v of await listVerifications(project)) {
    if (v.state === "closed") continue;
    const expired = Date.parse(v.expiresAt) <= Date.now() || execution.stale(project, v.epoch);
    const owned = owner === v.owner && runId === v.run;
    const orphaned = !pidAlive(v.ownerPid) && Date.now() - Date.parse(v.createdAt) > 120_000;
    const busy = (await listProcesses(project)).some(p => p.verification === v.id && liveProcess(p));
    if (expired || orphaned || (owned && !busy) || (v.state === "cleanup_failed" || v.state === "closing")) {
      const result = await closeVerification(project, v.id);
      if (result.state === "cleanup_failed") throw new Error(`verification ${v.id} cleanup incomplete: ${result.errors?.join("; ")}`);
    }
  }
}


async function evidenceBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
  if (!entry || entry.isSymbolicLink()) return 0;
  if (!entry.isDirectory()) return entry.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await evidenceBytes(join(path, name));
  return bytes;
}
export async function pruneVerificationEvidence(project: string): Promise<void> {
  const closed = (await listVerifications(project)).filter(v => v.state === "closed").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let retained = 0;
  for (const v of closed) {
    const paths = verificationPaths(project, v.id);
    retained += await evidenceBytes(paths.evidence);
    if (Date.now() - Date.parse(v.createdAt) < 7 * 86400_000 && retained <= 1024 ** 3) continue;
    await rm(paths.evidence, { recursive: true, force: true });
    await rm(paths.root, { recursive: true, force: true });
  }
}
