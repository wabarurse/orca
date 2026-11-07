import { mkdir, readdir, rename, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { assertProjectIdentity } from "../projects";
import { withStorageLock } from "../storage-lock";

export interface Verification {
  id: string; project: string; identity: string; epoch: string; owner: string; run?: string; ownerPid: number;
  source: string; objects?: string; backend: "local" | "docker"; image?: string; ports?: number[]; publishedPorts?: string;
  simulator?: { deviceType: string; runtime: string; device?: string };
  createdAt: string; expiresAt: string; state: "creating" | "active" | "closing" | "closed" | "cleanup_failed";
  errors?: string[];
}
export function verificationPaths(project: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid verification session");
  const root = join(paths.runtimeProject(project), "verification", id);
  return { root, workspace: join(root, "workspace"), devices: join(root, "devices"),
    evidence: join(paths.project(project), "tool-outputs", "verification", id), manifest: join(root, "session.json") };
}
export async function saveVerification(v: Verification): Promise<void> {
  assertProjectIdentity(v.project, v.identity, "saving verification session");
  const { root, manifest } = verificationPaths(v.project, v.id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.session-${crypto.randomUUID()}`);
  await writeFile(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
  await rename(tmp, manifest);
}
export async function readVerification(project: string, id: string): Promise<Verification> {
  const { root, manifest } = verificationPaths(project, id);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("unsafe verification directory");
  const v = await Bun.file(manifest).json() as Verification;
  if (v.project !== project || v.id !== id) throw new Error("verification identity mismatch");
  assertProjectIdentity(project, v.identity, "reading verification session");
  return v;
}
export async function listVerifications(project: string): Promise<Verification[]> {
  const dir = join(paths.runtimeProject(project), "verification");
  const names = await readdir(dir).catch(e => { if (e.code === "ENOENT") return []; throw e; });
  const sessions = [];
  for (const id of names.filter(name => /^[a-f0-9-]{36}$/.test(name))) sessions.push(await readVerification(project, id));
  return sessions;
}
export function verificationLock<T>(project: string, id: string, action: () => Promise<T>): Promise<T> {
  return withStorageLock(join(verificationPaths(project, id).root, "session.lock"), action);
}
