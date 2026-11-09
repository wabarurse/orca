// Verify a received bundle before anything touches the project: framing, versions, allowlist, per-file hashes,
// every transcript's ledger digest and contextDigest recomputed from the bytes actually received, and the
// contents of tasks, state, questions and images validated as their readers would. Any mismatch aborts; the
// caller has written nothing yet. A bundle made by hand is held to the same rules as one made by export.

import { validateImage } from "../../providers";
import { assertSettingsShape } from "../../providers/catalog";
import { sessionImageScope } from "../data/images";
import { questions } from "../data/inbox";
import { session, validateModel } from "../data/projects";
import { validateSessionTasks } from "../data/tasks";
import type { Question } from "../../protocol";
import type { Task } from "../../protocol/task";
import { assertBundlePath, checkManifest, decodeBundle, sha256, type BundleManifest } from "./bundle";
import { hasUserinfo } from "./export";
import { chainOf, imageRefs, ledgerDigest, ledgerOf, type Ledger } from "./ledger";
import type { StateFile } from "./snapshot";

export interface Verified {
  manifest: BundleManifest;
  files: Map<string, Buffer>;
  transcripts: Map<string, { text: string; ledger: Ledger; chainBytes: number }>;
  tasks: Task[];
  state: StateFile;
  questions: Map<string, Question>;
  images: Map<string, string>;
  inputs: Map<string, string>;
}
const dir = (path: string, prefix: string) => path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Frames, hashes and listed files agree with the manifest; returns the files by path. */
function checkedFiles(manifest: BundleManifest, records: { path: string; bytes: Uint8Array }[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const f of records) { assertBundlePath(f.path); files.set(f.path, Buffer.from(f.bytes)); }
  const listed = new Map(manifest.files.map(f => [f.path, f]));
  if (listed.size !== manifest.files.length || listed.size !== files.size) throw new Error("bundle files do not match its manifest (missing or extra files)");
  for (const [path, bytes] of files) {
    const entry = listed.get(path);
    if (!entry || entry.size !== bytes.length || entry.sha256 !== sha256(bytes)) throw new Error(`bundle file ${path} does not match its manifest hash (corrupted or tampered in transit)`);
  }
  return files;
}

/** Every transcript's ledger digest and contextDigest recomputed from the bytes actually received. */
async function checkedTranscripts(manifest: BundleManifest, files: Map<string, Buffer>): Promise<Verified["transcripts"]> {
  const scope = sessionImageScope(manifest.sessionId), transcripts: Verified["transcripts"] = new Map();
  for (const record of manifest.transcripts) {
    const bytes = files.get(`transcripts/${record.id}.jsonl`);
    if (!bytes) throw new Error(`manifest lists transcript ${record.id} but the bundle has no such file`);
    const text = bytes.toString("utf8"), ledger = ledgerOf(text, [scope], `transcripts/${record.id}.jsonl`), chain = await chainOf(text);
    if (ledger.entries.length !== record.entries || ledgerDigest(ledger) !== record.ledgerDigest) throw new Error(`transcript ${record.id}: ledger digest mismatch; nothing was imported`);
    if (chain.digest !== record.contextDigest) throw new Error(`transcript ${record.id}: contextDigest mismatch (the model context would differ from what was exported); nothing was imported`);
    if (!chain.paired) throw new Error(`transcript ${record.id}: unpaired tool calls in the context chain`);
    transcripts.set(record.id, { text, ledger, chainBytes: chain.bytes });
  }
  for (const path of files.keys()) {
    const id = dir(path, "transcripts");
    if (id && !transcripts.has(id.slice(0, -".jsonl".length))) throw new Error(`bundle has transcript ${id} that its manifest does not describe`);
  }
  return transcripts;
}

/** Questions, images and image prompts validated as the readers would. */
function checkedMedia(files: Map<string, Buffer>): Pick<Verified, "questions" | "images" | "inputs"> {
  const found = new Map<string, Question>(), images = new Map<string, string>(), inputs = new Map<string, string>();
  for (const [path, bytes] of files) {
    const q = dir(path, "questions"), img = dir(path, "images"), input = dir(path, "image-inputs");
    if (q) { const question = questions.checkedQuestion(JSON.parse(bytes.toString("utf8")), q); found.set(question.id, question); }
    if (img) { validateImage(bytes); images.set(img.replace(/\.[a-z]+$/, ""), sha256(bytes)); }
    if (input) { JSON.parse(bytes.toString("utf8")); inputs.set(input.slice(0, -".json".length), bytes.toString("utf8")); }
  }
  return { questions: found, images, inputs };
}

function checkedState(bytes: Buffer | undefined): StateFile {
  if (!bytes) throw new Error("bundle has no state.json");
  const state = JSON.parse(bytes.toString("utf8")) as StateFile;
  if (!isRecord(state) || state.version !== 1) throw new Error("invalid state.json");
  if (state.model !== undefined) validateModel(state.model);
  for (const key of ["modelSettings", "roleModels"] as const) if (state[key] !== undefined && !isRecord(state[key])) throw new Error(`invalid state.json ${key}`);
  for (const entry of Object.values(state.modelSettings ?? {})) assertSettingsShape(entry);
  return state;
}

/** Image references in the conversation must carry the session's own scope and match the hashes of the bundled files. */
function checkedRefs(manifest: BundleManifest, files: Map<string, Buffer>, images: Map<string, string>): void {
  const scope = sessionImageScope(manifest.sessionId);
  for (const [path, bytes] of files) {
    if (!dir(path, "transcripts") && !dir(path, "image-inputs")) continue;
    for (const ref of imageRefs(bytes.toString("utf8"))) {
      if (ref.scope !== scope) throw new Error(`${path} has an image reference outside this session's scope (a legacy or forged reference)`);
      const have = images.get(ref.id);
      if (have !== undefined && have !== ref.sha256) throw new Error(`${path}: image ${ref.id} does not match the hash recorded in the conversation`);
    }
  }
}

export async function verifyBundle(input: Uint8Array): Promise<Verified> {
  const { manifest: raw, files: records } = decodeBundle(input);
  const manifest = checkManifest(raw);
  if (!session.validSessionId(manifest.sessionId)) throw new Error("bundle has an invalid sessionId");
  validateModel(manifest.model.effective);
  session.validDisplayName(manifest.name);
  if (manifest.repository.origin && hasUserinfo(manifest.repository.origin)) throw new Error("bundle carries credentials in its origin URL; refusing");
  const files = checkedFiles(manifest, records);
  const transcripts = await checkedTranscripts(manifest, files);
  const media = checkedMedia(files);
  checkedRefs(manifest, files, media.images);
  const tasksBytes = files.get("tasks.json");
  const tasks = tasksBytes ? validateSessionTasks(JSON.parse(tasksBytes.toString("utf8"))) : [];
  return { manifest, files, transcripts, tasks, state: checkedState(files.get("state.json")), ...media };
}
