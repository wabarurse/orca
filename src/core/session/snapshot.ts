// What a project holds that a session transfer carries, read from disk in one shape for both export (the
// sending side) and import (the receiving side's current state). Reading is lock-free and read-only; callers
// that need a consistent view hold the project locks (guard.ts).
//
// CARRIED (everything else stays): the transcripts, tasks, questions, images and image prompt journals, the
// display name, and the project state keys in STATE_KEYS.
// NEVER CARRIED, by design: `account`, `provider-models` (an account is a local credential profile),
// `repository` (an absolute path: the receiver binds its own checkout), `archived-agents` (a local /agents view),
// tool-outputs/, images/prepared/ (a rebuildable cache), launches/, runs/, inbox/ (receipts live in the transcript),
// questions' .closed/.answered claim files, input-epoch, execution-stop.json, observations/, contexts/, processes/,
// verification/, admissions/, input history, memory.sqlite (the archive index is rebuilt by the orchestrator),
// auth/, config.toml and every lock.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths, readProjectState } from "../../config";
import { questions } from "../data/inbox";
import { displayName, effectiveModel, session } from "../data/projects";
import { existingTasks } from "../data/tasks";
import type { Question } from "../../protocol";
import type { Task } from "../../protocol/task";
import { sha256 } from "./bundle";

/** state.json: the project state keys that travel, by their name in the bundle. */
export const STATE_KEYS = { model: "model", modelSettings: "model-settings", roleModels: "role-models", facts: "facts", workingContext: "working-context", humanSources: "human-sources" } as const;
/** Project state keys that stay on their machine. A test requires every key the source reads or writes to be in one list. */
export const LOCAL_STATE_KEYS = ["name", "account", "provider-models", "repository", "archived-agents"] as const;
export interface StateFile { version: 1; model?: string; modelSettings?: Record<string, unknown>; roleModels?: Record<string, unknown>; facts?: unknown; workingContext?: unknown; humanSources?: unknown }

export interface ImageFile { id: string; ext: string; sha: string; bytes?: Buffer }
export interface Snapshot {
  project: string; sessionId?: string; name: string;
  transcripts: Map<string, string>;
  tasks: Task[];
  questions: Map<string, { question: Question; bytes: Buffer }>;
  images: Map<string, ImageFile>;
  /** images/inputs/<id>.json, by id */
  inputs: Map<string, string>;
  state: StateFile;
  /** Entries under the project that were skipped (not transferable names), for the report. */
  skipped: string[];
}

const ENOENT = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
export const TRANSCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
const IMAGE_NAME = new RegExp(`^(${UUID})\\.(png|jpg|gif|webp)$`);
const INPUT_NAME = new RegExp(`^(${UUID})\\.json$`);
const QUESTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** Regular files of `dir` whose names match `rx`; a symlink or other non-file is refused, other names are reported. */
async function regular(dir: string, rx: RegExp, skipped: string[], quiet: (n: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const names = await readdir(dir).catch(e => { if (ENOENT(e)) return [] as string[]; throw e; });
  for (const name of names.sort()) {
    if (quiet(name)) continue;
    const info = await lstat(join(dir, name));
    if (info.isDirectory() && !rx.test(name)) { skipped.push(`${dir.split("/").slice(-1)[0]}/${name}/`); continue; }
    if (!rx.test(name)) { skipped.push(`${dir.split("/").slice(-1)[0]}/${name}`); continue; }
    if (!info.isFile()) throw new Error(`${join(dir, name)} is not a regular file (symlinks are never followed)`);
    out.push(name);
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The state keys as one file; model is materialized (the effective model, whether saved or inherited from config). */
export async function readState(project: string): Promise<StateFile> {
  const state: StateFile = { version: 1, model: await effectiveModel(project) };
  const settings = readProjectState<unknown>(project, STATE_KEYS.modelSettings), roles = readProjectState<unknown>(project, STATE_KEYS.roleModels);
  if (settings !== undefined) { if (!isRecord(settings)) throw new Error("invalid project model settings"); state.modelSettings = settings; }
  if (roles !== undefined) { if (!isRecord(roles)) throw new Error("invalid project role models"); state.roleModels = roles; }
  for (const key of ["facts", "workingContext", "humanSources"] as const) {
    const value = readProjectState<unknown>(project, STATE_KEYS[key]);
    if (value !== undefined) state[key] = value;
  }
  return state;
}

/** Everything transferable the project holds. `withBytes` keeps image bytes (export); without, only their hashes (comparison). */
export async function readSnapshot(project: string, withBytes: boolean): Promise<Snapshot> {
  const dir = paths.project(project), skipped: string[] = [];
  const snap: Snapshot = {
    project, sessionId: session.readSession(project)?.sessionId, name: await displayName(project),
    transcripts: new Map(), tasks: existingTasks(project), questions: new Map(), images: new Map(), inputs: new Map(), state: await readState(project), skipped,
  };
  const quietTranscript = (n: string) => /\.jsonl\.(launch|cancel|lock|pending)$/.test(n) || /\.jsonl\.[0-9a-f-]+\.pending$/.test(n) || /\.tmp$/.test(n);
  for (const name of await regular(join(dir, "transcript"), TRANSCRIPT_NAME, skipped, quietTranscript)) snap.transcripts.set(name.slice(0, -".jsonl".length), await readFile(join(dir, "transcript", name), "utf8"));
  for (const name of await regular(paths.questions(project), QUESTION_NAME, skipped, n => /\.(closed|answered|tmp)$/.test(n) || n.startsWith("."))) {
    const bytes = await readFile(join(paths.questions(project), name));
    const question = questions.checkedQuestion(JSON.parse(bytes.toString("utf8")), name);
    snap.questions.set(question.id, { question, bytes });
  }
  for (const name of await regular(join(dir, "images"), IMAGE_NAME, skipped, n => /\.tmp$/.test(n) || n === "inputs")) {
    const [, id, ext] = IMAGE_NAME.exec(name)!, bytes = await readFile(join(dir, "images", name));
    snap.images.set(id!, { id: id!, ext: ext!, sha: sha256(bytes), ...(withBytes ? { bytes } : {}) });
  }
  for (const name of await regular(join(dir, "images", "inputs"), INPUT_NAME, skipped, n => /\.tmp$/.test(n))) snap.inputs.set(name.slice(0, -".json".length), await readFile(join(dir, "images", "inputs", name), "utf8"));
  return snap;
}

/** The state of a project that does not exist yet: nothing, with this machine's default model. */
export async function emptySnapshot(): Promise<Snapshot> {
  return { project: "", name: "", transcripts: new Map(), tasks: [], questions: new Map(), images: new Map(), inputs: new Map(), state: { version: 1, model: (await loadConfig()).model }, skipped: [] };
}
