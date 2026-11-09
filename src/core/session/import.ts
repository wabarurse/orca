// Import a session bundle into this machine's orca state.
//
// Order: verify the bundle (nothing touched) -> take the machine-wide import lock and settle any interrupted import
// -> pick the destination (sessionId, or --adopt for a same-named project without one, or a new project / --as fork)
// -> take the turn and state locks and refuse if anything is live or queued -> compare every entity against the local
// copy and refuse the whole transfer on any divergence/conflict -> stage the resulting files -> re-verify the staged
// bytes -> publish with a journal (publish.ts).
//
// What an import never does: start agents, call a provider, consume queues, copy config.toml, auth or absolute paths.
// It binds a new project to a checkout on this machine (a fresh repository binding, never the sender's). The
// conversation resumes only by re-sending the stored chain: no provider session exists to move, the prompt cache is
// cold on the first request, and thinking/encrypted-reasoning replay across different accounts is untested.

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { conversationIds, paths, repositoryBinding } from "../../config";
import { sessionImageScope } from "../data/images";
import { initializeWorkspace, listProjects, newProjectName, session, setDisplayName, withProjectStateLock } from "../data/projects";
import { assertQuiescent, withImportLock, withQuietProject, type TransferDeps } from "./guard";
import { chainOf, ledgerDigest, ledgerOf } from "./ledger";
import { resolveTarget, takenNames } from "./local";
import { planImport, type Plan } from "./plan";
import { pendingImports, publish, recoverImports, type PublishInput } from "./publish";
import { emptySnapshot, readSnapshot } from "./snapshot";
import { verifyBundle, type Verified } from "./verify";

export interface ImportOptions {
  /** Import as a separate new project with this display name (fresh folder id and sessionId). */
  as?: string;
  /** This machine's checkout of the repository; required for a project that does not exist here yet. */
  checkout?: string;
  /** Merge into the one same-named local project that has no session id yet. */
  adopt?: boolean;
  dryRun?: boolean;
  /** Who the bundle came from (host name), recorded in the sync ledger. */
  peer: string;
  /** Test seam: see PublishInput.hook. */
  hook?: PublishInput["hook"];
}
export interface ImportReport {
  project: string; outcome: "created" | "forked" | "updated" | "unchanged"; sessionId: string;
  lines: string[]; warnings: string[]; backup?: string; dryRun: boolean;
}

/** The transfer was refused as a whole and nothing was written. */
export class TransferRefused extends Error {
  constructor(readonly reasons: string[]) { super(`transfer refused, nothing was written:\n${reasons.map(r => `  - ${r}`).join("\n")}`); }
}

export const NOTICES = [
  "orca keeps no provider-side session: the conversation resumes by re-sending the stored history, and the first request here is a prompt-cache miss.",
  "System prompt, model access and config.toml here may differ from the sending machine; thinking/encrypted-reasoning replay across different Claude/Codex accounts is unverified.",
  "Transcripts can contain secrets that were pasted into the conversation, and absolute paths of the sending machine in tool calls and results; they were transferred as they are.",
];

const normalizeRemote = (url: string) => url.trim().replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/:(?!\d+\/)/, "/").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

/** A refusal when `directory`'s origin is not the repository the session was made in; warnings for what cannot be verified. */
async function checkOrigin(v: Verified, directory: string, branch: string, warnings: string[], deps: TransferDeps): Promise<string | undefined> {
  const origin = await deps.origin(directory), wanted = v.manifest.repository.origin;
  if (wanted && !origin) return `${directory} has no origin remote, but the session was made in ${wanted}`;
  if (wanted && origin && normalizeRemote(wanted) !== normalizeRemote(origin)) return `${directory} has origin ${origin}, but the session was made in ${wanted}; pass the right clone`;
  if (!wanted) warnings.push("the sending checkout had no origin remote, so the repository could not be verified");
  if (branch !== v.manifest.repository.branch) warnings.push(`default branch here is ${branch || "(none: not a git checkout)"}, the sending side used ${v.manifest.repository.branch || "(none)"}`);
}

/** A validated checkout for a new project, refusing a repository that is not the one the session was made in. */
async function bindCheckout(v: Verified, checkout: string | undefined, warnings: string[], deps: TransferDeps): Promise<string> {
  if (!checkout) throw new TransferRefused([`${v.manifest.name} does not exist on this machine yet and absolute paths are never transferred: pass --checkout <your local clone of the repository>`]);
  if (!existsSync(checkout)) throw new TransferRefused([`--checkout ${checkout} does not exist`]);
  const bound = await session.validateProjectDirectory(checkout).catch(error => { throw new TransferRefused([`--checkout ${checkout}: ${error instanceof Error ? error.message : error}`]); });
  const problem = await checkOrigin(v, bound.directory, bound.branch, warnings, deps);
  if (problem) throw new TransferRefused([problem]);
  return bound.directory;
}

/** Staged transcripts must still be exactly what the manifest promised: ledger digest and contextDigest recomputed. */
async function verifyStage(v: Verified, plan: Plan, scope: string, stage: string, order: { path: string }[]): Promise<void> {
  const incoming = sessionImageScope(v.manifest.sessionId);
  for (const record of v.manifest.transcripts.filter(r => plan.incoming.includes(r.id))) {
    const index = order.findIndex(w => w.path === `transcript/${record.id}.jsonl`);
    const text = await Bun.file(join(stage, "files", String(index))).text();
    const ledger = ledgerOf(text, [scope], `staged ${record.id}`), chain = await chainOf(text, scope === incoming ? undefined : { from: scope, to: incoming });
    if (ledgerDigest(ledger) !== record.ledgerDigest || ledger.entries.length !== record.entries) throw new Error(`staged transcript ${record.id} differs from the exported ledger; nothing was published`);
    if (chain.digest !== record.contextDigest || !chain.paired) throw new Error(`staged transcript ${record.id} does not reproduce the exported contextDigest; nothing was published`);
  }
}

function syncRecord(v: Verified, plan: Plan, o: ImportOptions, now: Date, previous: session.SessionFile | undefined, sessionId: string, forkedFrom?: string): session.SessionFile {
  return { ...(previous ?? {}), version: 1, sessionId, sync: { peer: o.peer, at: now.toISOString(), orcaVersion: v.manifest.orcaVersion, transcripts: plan.heads, ...(forkedFrom ? { forkedFrom } : {}) } };
}

function report(project: string, outcome: ImportReport["outcome"], sessionId: string, plan: Plan, o: ImportOptions, extra: { warnings?: string[]; backup?: string } = {}): ImportReport {
  return { project, outcome, sessionId, lines: plan.lines, warnings: [...(extra.warnings ?? []), ...plan.warnings, ...NOTICES], dryRun: !!o.dryRun, ...(extra.backup ? { backup: extra.backup } : {}) };
}
const changed = (plan: Plan) => !!(plan.writes.length || plan.state.length || plan.tasks);

async function updateExisting(v: Verified, project: string, adopt: boolean, o: ImportOptions, deps: TransferDeps): Promise<ImportReport> {
  const binding = repositoryBinding(project);
  if (!binding) throw new TransferRefused([`${project} is a legacy clone-based project (repo/ inside its folder) and cannot receive a session`]);
  const warnings: string[] = [];
  if (o.checkout && existsSync(o.checkout) && realpathSync(o.checkout) !== realpathSync(binding.directory)) throw new TransferRefused([`${project} is already bound to ${binding.directory}; leave out --checkout (an existing project keeps its checkout) or use --as for a separate copy`]);
  const problem = await checkOrigin(v, binding.directory, binding.branch, warnings, deps);
  if (problem) throw new TransferRefused([problem]);
  return withQuietProject(project, async () => {
    await assertQuiescent(project, deps, "import into");
    const stuck = await pendingImports(project);
    if (stuck.length) throw new TransferRefused([`an earlier import into ${project} was interrupted (${stuck.join(", ")}); run \`orca session recover\` first`]);
    const local = await readSnapshot(project, false), previous = session.readSession(project);
    const plan = await planImport({ v, local, project, now: deps.now().toISOString() }, false, await takenNames(project));
    if (plan.refusals.length) throw new TransferRefused(plan.refusals);
    const sessionId = previous?.sessionId ?? v.manifest.sessionId, outcome = changed(plan) ? "updated" : "unchanged";
    if (adopt) plan.lines.push(`adopted: ${project} had no session id; it now carries ${sessionId}`);
    if (o.dryRun) return report(project, outcome, sessionId, plan, o, { warnings });
    const published = await publish({
      project, created: false, writes: plan.writes, state: plan.state, tasks: plan.tasks, now: deps.now(), hook: o.hook,
      session: syncRecord(v, plan, o, deps.now(), previous, sessionId),
      verify: (stage, order) => verifyStage(v, plan, sessionIdScope(v), stage, order),
    });
    if (plan.name) await renamed(project, plan.name, plan);
    return report(project, outcome, sessionId, plan, o, { warnings, backup: published.backup });
  });
}
const sessionIdScope = (v: Verified) => sessionImageScope(v.manifest.sessionId);

/** The folder write of a name already committed: refresh the readable folder links. A race with /rename is a warning, never a failure. */
async function renamed(project: string, name: string, plan: Plan): Promise<void> {
  try { await setDisplayName(project, name); }
  catch (error) { plan.warnings.push(`the display name "${name}" could not be finalized (${error instanceof Error ? error.message : error})`); }
}

async function createNew(v: Verified, name: string, fork: boolean, o: ImportOptions, deps: TransferDeps): Promise<ImportReport> {
  const warnings: string[] = [], directory = await bindCheckout(v, o.checkout, warnings, deps);
  const taken = await takenNames();
  if (taken.has(name)) throw new TransferRefused([`a project here is already called "${name}"; pass --as <another name> for a separate copy`]);
  const sessionId = fork ? randomUUID() : v.manifest.sessionId, rescope = fork ? sessionImageScope(sessionId) : undefined;
  const plan = await planImport({ v, local: await emptySnapshot(), rescope, name, now: deps.now().toISOString() }, true, taken);
  if (plan.refusals.length) throw new TransferRefused(plan.refusals);
  const outcome = fork ? "forked" : "created";
  if (o.dryRun) return report("(new project)", outcome, sessionId, plan, o, { warnings });
  const project = newProjectName([...new Set([...conversationIds(paths.root), ...(await listProjects())])]);
  const scope = rescope ?? sessionIdScope(v);
  const published = await withProjectStateLock(project, async () => {
    await initializeWorkspace(project, directory);
    return publish({
      project, created: true, writes: plan.writes, state: plan.state, tasks: plan.tasks, now: deps.now(), hook: o.hook,
      session: syncRecord(v, plan, o, deps.now(), undefined, sessionId, fork ? v.manifest.sessionId : undefined),
      verify: (stage, order) => verifyStage(v, plan, scope, stage, order),
    });
  });
  if (plan.name) await renamed(project, plan.name, plan);
  plan.lines.push(fork ? `forked as a separate project ${project} with a new session id (the source's was ${v.manifest.sessionId})` : `created project ${project} bound to ${directory}`);
  return report(project, outcome, sessionId, plan, o, { warnings, backup: published.backup });
}

/** Import a bundle. Throws TransferRefused when nothing may be written, and Error for anything else that went wrong. */
export async function importSession(input: Uint8Array, deps: TransferDeps, o: ImportOptions): Promise<ImportReport> {
  const v = await verifyBundle(input);
  const as = o.as === undefined ? undefined : session.validDisplayName(o.as);
  return withImportLock(async () => {
    const recovered = o.dryRun ? [] : await recoverImports();
    const target = await resolveTarget(v.manifest);
    let result: ImportReport;
    if (as !== undefined) result = await createNew(v, as, true, o, deps);
    else if (target.project) result = await updateExisting(v, target.project, false, o, deps);
    else if (target.adoptable && o.adopt) result = await updateExisting(v, target.adoptable, true, o, deps);
    else if (target.adoptable) throw new TransferRefused([`"${v.manifest.name}" exists here (${target.adoptable}) but has no session id, so it cannot be told apart from an unrelated project of the same name. Pass --adopt to merge into it, or --as <name> to import a separate copy`]);
    else if (target.collisions.length) throw new TransferRefused([`${target.collisions.length === 1 ? "another project" : `${target.collisions.length} other projects`} here (${target.collisions.join(", ")}) already ${target.collisions.length === 1 ? "is" : "are"} called "${v.manifest.name}" but ${target.collisions.length === 1 ? "is a" : "are"} different session${target.collisions.length === 1 ? "" : "s"}; pass --as <another name> for a separate copy`]);
    else result = await createNew(v, v.manifest.name, false, o, deps);
    result.lines.unshift(...recovered);
    return result;
  });
}
