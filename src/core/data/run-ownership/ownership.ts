// Dormant trusted-supervisor API. No task status, tmux observation or PID probe
// is termination evidence. Callers must reserve before permitting execution.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { assertProjectIdentity, withProjectStateLock } from "../projects";
import { check, object } from "../../../protocol/task";

export interface RunOwner {
  project: string; incarnation: string; branch: string; task: string;
  role: "worker" | "reviewer"; agent: string; run: string;
  // PID reuse requires host/boot identity and an OS-observed process birth token.
  supervisor: { host: string; boot: string; pid: number; birth: string };
}
export interface TerminationEvidence {
  owner: RunOwner;
  supervisor: "exited" | "alive" | "unknown";
  descendants: "gone" | "alive" | "unknown";
  containment: "sealed" | "unknown";
}
interface Record { owner: RunOwner; state: "owned" | "stopping" | "released" }
interface Store { version: 1; incarnation: string; records: Record[] }
const nonempty = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 500 && !/[\x00-\x1f\x7f]/.test(s);
function validate(o: unknown): asserts o is RunOwner {
  check(object(o) && nonempty(o.project) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.project), "invalid ownership project");
  check([o.incarnation, o.branch, o.task, o.agent, o.run].every(nonempty) && ["worker", "reviewer"].includes(String(o.role)), "invalid run identity");
  check(object(o.supervisor) && [o.supervisor.host, o.supervisor.boot, o.supervisor.birth].every(nonempty) && Number.isSafeInteger(o.supervisor.pid) && Number(o.supervisor.pid) > 0, "invalid supervisor identity");
}
const key = (o: RunOwner) => JSON.stringify([o.project, o.incarnation, o.branch, o.task, o.role, o.agent, o.run, o.supervisor.host, o.supervisor.boot, o.supervisor.pid, o.supervisor.birth]);
function validateStore(store: Store, owner: RunOwner): void {
  check(object(store) && store.version === 1 && store.incarnation === owner.incarnation && Array.isArray(store.records), "ownership missing/corrupt or project recreated; recovery required");
  const runs = new Set<string>(), branches = new Set<string>();
  for (const r of store.records) {
    check(object(r), "corrupt ownership record"); validate(r.owner);
    check(r.owner.project === owner.project && r.owner.incarnation === owner.incarnation && ["owned", "stopping", "released"].includes(r.state), "corrupt ownership identity/state");
    check(!runs.has(r.owner.run), "duplicate ownership run"); runs.add(r.owner.run);
    if (r.state !== "released") { check(!branches.has(r.owner.branch), "duplicate branch owner"); branches.add(r.owner.branch); }
  }
}
async function update<T>(owner: RunOwner, action: (s: Store) => T): Promise<T> {
  // Snapshot caller-owned objects before awaiting, including nested identity.
  owner = structuredClone(owner); validate(owner);
  return withProjectStateLock(owner.project, async () => {
    assertProjectIdentity(owner.project, owner.incarnation, "updating run ownership");
    // Outside the project: recreation must not erase a possibly-live lease.
    const dir = join(paths.root, "run-ownership"), file = join(dir, `${owner.project}.json`);
    let store: Store;
    try { store = JSON.parse(await readFile(file, "utf8")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      store = { version: 1, incarnation: owner.incarnation, records: [] };
    }
    validateStore(store, owner);
    const before = JSON.stringify(store), result = action(store), after = JSON.stringify(store);
    if (before !== after) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(tmp, after + "\n", { flag: "wx", mode: 0o600 });
        assertProjectIdentity(owner.project, owner.incarnation, "committing run ownership");
        await rename(tmp, file);
      } finally { await rm(tmp, { force: true }); }
    }
    return result;
  });
}
/** Clearance is a trusted containment inventory, never task-terminal/tmux-absent.
 * Missing ledger requires this evidence too; unknown never bootstraps ownership.
 * Reservation is durable before launch; no execution until acquisition succeeds.
 * True also acknowledges owned/stopping retries, NOT permission to launch again.
 * The later supervisor must enforce one launch per immutable run.
 */
export async function acquireRunOwnership(owner: RunOwner, clearance: "verified-clear" | "unknown"): Promise<boolean> {
  owner = structuredClone(owner);
  return update(owner, s => {
    const prior = s.records.find(r => r.owner.run === owner.run);
    if (prior) return key(prior.owner) === key(owner) && prior.state !== "released";
    if (clearance !== "verified-clear" || s.records.some(r => r.owner.branch === owner.branch && r.state !== "released")) return false;
    s.records.push({ owner, state: "owned" }); return true;
  });
}
/** Stop intent preserves the lease; old requests cannot target a successor. */
export async function requestRunStop(owner: RunOwner): Promise<boolean> {
  owner = structuredClone(owner);
  return update(owner, s => {
    const r = s.records.find(r => key(r.owner) === key(owner));
    if (!r || r.state === "released") return false;
    r.state = "stopping"; return true;
  });
}
/** Trusted verifier attestation, not an OS verifier itself. Sealed means no new
 * children can start and every tracked/escaped descendant has been accounted for.
 * Parent exit alone, missing evidence, timeout and unverifiable escape retain it.
 */
export async function releaseRunOwnership(owner: RunOwner, evidence: TerminationEvidence): Promise<boolean> {
  owner = structuredClone(owner); evidence = structuredClone(evidence); validate(evidence.owner);
  return update(owner, s => {
    const r = s.records.find(r => key(r.owner) === key(owner));
    if (!r || key(evidence.owner) !== key(owner) || evidence.supervisor !== "exited" || evidence.descendants !== "gone" || evidence.containment !== "sealed") return false;
    r.state = "released"; return true;
  });
}
