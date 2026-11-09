// Export a project as a session bundle (bundle.ts). Read-only apart from minting the stable sessionId on
// first export (never in a dry run).
//
// Only an allowlist leaves the machine (snapshot.ts lists what travels and what never does). Absolute paths and
// credentials never travel: the bound checkout, auth profiles and config.toml stay, the origin URL is stripped of
// userinfo, and the receiver binds its own checkout. NOTE: transcripts themselves can contain absolute paths of
// the sending machine (tool calls and results quote them) and secrets pasted into the conversation; they are
// carried byte for byte, because rewriting them would change the conversation.

import { randomUUID } from "node:crypto";
import { loadConfig, repositoryBinding } from "../../config";
import { session } from "../data/projects";
import { sessionImageScope } from "../data/images";
import { LAYOUT_VERSION, MANIFEST_VERSION, SCHEMAS, orcaVersion, encodeBundle, sha256, type BundleFile, type BundleManifest, type TranscriptRecord } from "./bundle";
import { chainOf, imageRefs, ledgerDigest, ledgerOf, type ImageRefSeen } from "./ledger";
import { assertQuiescent, withQuietProject, type TransferDeps } from "./guard";
import { pendingImports } from "./publish";
import { readSnapshot, type Snapshot } from "./snapshot";

export interface ExportResult { bundle: Buffer; manifest: BundleManifest; warnings: string[]; project: string }
/** Settings that shape agent behavior; informational in the manifest, never copied into the receiver's config.toml. */
const CONFIG_KEYS = ["sandbox", "compact", "workerContextTokens", "contextLimitFallback", "anthropicPromptCache", "toolConcurrency", "maxToolOutputBytes", "maxToolResultBytes"] as const;

/** An origin URL without credentials: `https://user:token@host/x.git` and `user@host:x.git` lose their userinfo. */
export function stripUserinfo(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, "$1").replace(/^[^@/:\s]+(?::[^@/\s]*)?@(?=[^/\s]+:)/, "");
}
const stripOrigin = (url: string | null) => url === null ? null : stripUserinfo(url);
export const hasUserinfo = (url: string) => stripUserinfo(url) !== url.trim();

interface Collected { files: BundleFile[]; transcripts: TranscriptRecord[]; refs: ImageRefSeen[] }

async function collectTranscripts(snap: Snapshot, scope: string, c: Collected): Promise<void> {
  for (const [id, text] of [...snap.transcripts].sort(([a], [b]) => a.localeCompare(b))) {
    const ledger = ledgerOf(text, [scope], `transcript/${id}.jsonl`), chain = await chainOf(text);
    if (!chain.paired) throw new Error(`transcript/${id}.jsonl: the current context has unpaired or mismatched tool calls; refusing to export a chain a provider would reject`);
    c.transcripts.push({ id, entries: ledger.entries.length, ledgerDigest: ledgerDigest(ledger), contextDigest: chain.digest, chainMessages: chain.messages });
    c.refs.push(...imageRefs(text));
    c.files.push({ path: `transcripts/${id}.jsonl`, bytes: Buffer.from(text) });
  }
  if (!c.transcripts.some(t => t.id === "orchestrator")) throw new Error(`${snap.project} has no orchestrator transcript; nothing to transfer`);
}

function collectRegistry(snap: Snapshot, c: Collected): void {
  c.files.push({ path: "tasks.json", bytes: Buffer.from(JSON.stringify({ version: SCHEMAS.tasks, tasks: snap.tasks }) + "\n") });
  c.files.push({ path: "state.json", bytes: Buffer.from(JSON.stringify(snap.state) + "\n") });
  for (const { question, bytes } of snap.questions.values()) c.files.push({ path: `questions/${question.id}.json`, bytes });
}

function collectMedia(snap: Snapshot, c: Collected): void {
  for (const image of snap.images.values()) c.files.push({ path: `images/${image.id}.${image.ext}`, bytes: image.bytes! });
  for (const [id, text] of snap.inputs) { c.refs.push(...imageRefs(text)); c.files.push({ path: `image-inputs/${id}.json`, bytes: Buffer.from(text) }); }
}

/**
 * Every image reference must carry this project's sessionId scope (that is what lets the images load elsewhere) and
 * resolve to a file whose hash it records. Legacy folder-derived scopes cannot be carried: refused, never rewritten.
 */
function checkImageRefs(snap: Snapshot, scope: string, refs: ImageRefSeen[], warnings: string[]): void {
  const foreign = refs.find(r => r.scope !== scope);
  if (foreign) throw new Error(`${snap.project} has image references in a legacy scope (folder-derived, from before sessions had a stable id); they could not be loaded on another machine, so the project cannot be exported. Start a new conversation for transfer, or keep working here`);
  const missing = new Set<string>();
  for (const ref of refs) {
    const image = snap.images.get(ref.id);
    if (!image) missing.add(ref.id);
    else if (image.sha !== ref.sha256) throw new Error(`image ${ref.id} does not match the hash recorded in the conversation; refusing to export a corrupt image`);
  }
  for (const id of missing) warnings.push(`image ${id} is referenced but its file is missing on this machine; the reference is carried as is`);
}

async function manifestFor(snap: Snapshot, c: Collected, sessionId: string, deps: TransferDeps): Promise<BundleManifest> {
  const binding = repositoryBinding(snap.project)!, config = await loadConfig(), model = snap.state.model!;
  const settings = (snap.state.modelSettings?.[model] ?? {}) as Record<string, unknown>;
  return {
    manifestVersion: MANIFEST_VERSION, orcaVersion, layoutVersion: LAYOUT_VERSION, schemas: { ...SCHEMAS },
    sessionId, name: session.validDisplayName(snap.name), folderId: snap.project, host: deps.hostname(), exportedAt: deps.now().toISOString(),
    model: { effective: model, settings },
    config: Object.fromEntries(CONFIG_KEYS.map(k => [k, config[k]])),
    repository: { origin: stripOrigin(await deps.origin(binding.directory)), branch: binding.branch },
    transcripts: c.transcripts, files: c.files.map(f => ({ path: f.path, size: f.bytes.length, sha256: sha256(f.bytes) })),
  };
}

export async function exportSession(project: string, deps: TransferDeps, opts: { dryRun?: boolean } = {}): Promise<ExportResult> {
  if (!repositoryBinding(project)) throw new Error(`${project} is a legacy clone-based project (repo/ inside its folder); session transfer needs a project bound to a checkout. Nothing was exported`);
  return withQuietProject(project, async () => {
    await assertQuiescent(project, deps, "export");
    const stuck = await pendingImports(project);
    if (stuck.length) throw new Error(`cannot export ${project}: an import into it was interrupted (${stuck.join(", ")}); run \`orca session recover\` first`);
    // No session.json yet means no current-scope image refs can exist; a dry run does not mint one.
    const sessionId = opts.dryRun ? session.readSession(project)?.sessionId ?? randomUUID() : await session.ensureSessionId(project);
    const snap = await readSnapshot(project, true), scope = sessionImageScope(sessionId), warnings: string[] = [];
    const c: Collected = { files: [], transcripts: [], refs: [] };
    await collectTranscripts(snap, scope, c);
    collectRegistry(snap, c);
    collectMedia(snap, c);
    checkImageRefs(snap, scope, c.refs, warnings);
    if (snap.skipped.length) warnings.push(`not carried (not session content): ${snap.skipped.join(", ")}`);
    const manifest = await manifestFor(snap, c, sessionId, deps);
    return { bundle: encodeBundle(manifest, c.files), manifest, warnings, project };
  });
}
