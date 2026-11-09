// Decide what an import changes, without touching disk: compare every transcript by ledger prefix, merge tasks and
// questions, apply the orchestrator-unit rule, and list the writes. "source" is the incoming bundle, "destination" the
// local project (an empty snapshot for a new project or a fork). Any conflict refuses the whole transfer: the plan
// then carries `refusals` and no writes.

import { loadConfig } from "../../config";
import { legacyImageScope, sessionImageScope } from "../data/images";
import { contextWindow, validateSettings } from "../../providers/catalog";
import type { Question } from "../../protocol";
import type { Task } from "../../protocol/task";
import { SCOPE_PLACEHOLDER, sha256, type BundleManifest } from "./bundle";
import { describeDivergence, ledgerDigest, ledgerOf, relate, replaceScopes, type Relation } from "./ledger";
import { interruptTasks, mergeQuestions, mergeTasks, unitConflict, type Direction } from "./merge";
import { STATE_KEYS, type Snapshot, type StateFile } from "./snapshot";
import type { Verified } from "./verify";

/** `area` says where `path` lives: inside the project folder, or in the project's runtime questions directory. */
export interface Write { area: "project" | "questions"; path: string; bytes: Uint8Array }
export interface StateChange { key: string; value: unknown }
export interface Plan {
  writes: Write[]; refusals: string[]; lines: string[]; warnings: string[];
  /** transcripts written (their bytes are the bundle's, re-scoped for a fork) */
  incoming: string[];
  /** agreed ledger heads after the import, for the sync ledger */
  heads: Record<string, { entries: number; ledgerDigest: string }>;
  sourceWins: boolean;
  /** merged task records to apply, when anything changed */
  tasks?: Task[];
  state: StateChange[];
  name?: string;
}
export interface PlanInput {
  v: Verified; local: Snapshot; project?: string;
  /** Fork: the incoming image scope is replaced by this one in transcripts and image prompts. */
  rescope?: string;
  /** The display name to give a new project (a fork's --as); defaults to the bundle's. */
  name?: string;
  now: string;
}
type Incoming = Verified["transcripts"] extends Map<string, infer V> ? V : never;
const json = (v: unknown) => JSON.stringify(v);
const DIRECTION: Record<Relation["kind"], Direction> = { equal: "equal", "fast-forward": "source", "destination-newer": "dest", diverged: "both" };
const incomingScope = (i: PlanInput) => sessionImageScope(i.v.manifest.sessionId);

/** Take the incoming transcript as it is (re-scoped for a fork) and record it as the agreed head. */
function accept(i: PlanInput, plan: Plan, id: string, t: Incoming): void {
  const bytes = i.rescope ? replaceScopes(t.text, [incomingScope(i)], i.rescope) : t.text;
  plan.writes.push({ area: "project", path: `transcript/${id}.jsonl`, bytes: Buffer.from(bytes) });
  plan.incoming.push(id);
  plan.heads[id] = { entries: t.ledger.entries.length, ledgerDigest: ledgerDigest(t.ledger) };
}

/** One transcript against its local copy; returns the direction it moves in. */
function relateOne(i: PlanInput, plan: Plan, id: string, t: Incoming, localText: string): Direction {
  const scopes = [incomingScope(i), ...(i.project && !i.rescope ? [legacyImageScope(i.project)] : [])];
  const local = ledgerOf(localText, scopes, `local transcript/${id}.jsonl`), r = relate(t.ledger, local);
  if (r.kind === "diverged") plan.refusals.push(describeDivergence(id, r));
  else if (r.kind === "fast-forward") {
    plan.lines.push(`${id}: fast-forward (+${r.onlySource} entries, ${r.common} already here)`);
    accept(i, plan, id, t);
  } else {
    plan.lines.push(r.kind === "equal" ? `${id}: identical, nothing to do` : `${id}: the receiving side is newer (+${r.onlyDestination} entries the sending side lacks); kept as is`);
    plan.heads[id] = { entries: local.entries.length, ledgerDigest: ledgerDigest(local) };
  }
  return DIRECTION[r.kind];
}

function transcriptPlan(i: PlanInput, plan: Plan): Direction {
  let orchestrator: Direction = "equal";
  for (const [id, t] of i.v.transcripts) {
    const localText = i.local.transcripts.get(id);
    let direction: Direction = "source";
    if (localText === undefined) { plan.lines.push(`${id}: new here (${t.ledger.entries.length} entries)`); accept(i, plan, id, t); }
    else direction = relateOne(i, plan, id, t, localText);
    if (id === "orchestrator") orchestrator = direction;
  }
  for (const id of i.local.transcripts.keys()) if (!i.v.transcripts.has(id)) plan.lines.push(`${id}: only on the receiving side; kept`);
  return orchestrator;
}

function imageWrites(i: PlanInput, plan: Plan, canonical: (text: string) => string): void {
  for (const [path, bytes] of i.v.files) {
    if (path.startsWith("images/")) {
      const id = path.slice(7).replace(/\.[a-z]+$/, ""), have = i.local.images.get(id);
      if (have === undefined) plan.writes.push({ area: "project", path, bytes });
      else if (have.sha !== sha256(bytes)) plan.refusals.push(`image ${id}: different bytes on the two sides (same id, different sha256); refusing`);
    } else if (path.startsWith("image-inputs/")) {
      const id = path.slice(13, -5), have = i.local.inputs.get(id), text = bytes.toString("utf8");
      if (have === undefined) plan.writes.push({ area: "project", path: `images/inputs/${id}.json`, bytes: Buffer.from(i.rescope ? replaceScopes(text, [incomingScope(i)], i.rescope) : text) });
      else if (canonical(have) !== canonical(text)) plan.refusals.push(`image prompt ${id}: different content on the two sides; refusing`);
    }
  }
}

function mediaPlan(i: PlanInput, plan: Plan): void {
  const scopes = [incomingScope(i), ...(i.project ? [legacyImageScope(i.project)] : []), ...(i.rescope ? [i.rescope] : [])];
  imageWrites(i, plan, text => replaceScopes(text, scopes, SCOPE_PLACEHOLDER));
}

const settingsOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Per-model merge: the sending side's entry for a model replaces this side's entry for that model; models only here are kept.
 * The effective model's entry must pass capability validation, or it is skipped with a warning (other entries are shape-checked at verify). */
function mergeSettings(incoming: StateFile, local: StateFile, effective: string, plan: Plan): Record<string, unknown> | undefined {
  if (!incoming.modelSettings) return;
  const merged = { ...settingsOf(local.modelSettings) };
  for (const [model, entry] of Object.entries(incoming.modelSettings)) {
    try { if (model === effective) validateSettings(model, entry as Parameters<typeof validateSettings>[1]); }
    catch (error) { plan.warnings.push(`the sending side's effort/fast settings for ${model} were not applied (${error instanceof Error ? error.message : error}); ${model} runs with defaults here`); continue; }
    merged[model] = entry;
  }
  return merged;
}

/** The sending side's value of a state key, when it differs from this side's. */
const differs = (incoming: unknown, local: unknown) => incoming !== undefined && json(incoming) !== json(local);

async function statePlan(i: PlanInput, plan: Plan): Promise<void> {
  const inc = i.v.state, loc = i.local.state, config = await loadConfig();
  if (!plan.sourceWins) {
    for (const [name, key] of Object.entries(STATE_KEYS)) {
      const k = name as keyof StateFile;
      if (differs(inc[k], loc[k])) plan.lines.push(`${key}: kept this machine's (the orchestrator transcript did not come from the sending side)`);
    }
    return;
  }
  const effective = inc.model ?? i.v.manifest.model.effective;
  if (effective !== loc.model) {
    plan.state.push({ key: STATE_KEYS.model, value: effective });
    plan.lines.push(`model: ${effective} (as on the sending side; this machine's default is ${config.model})`);
  }
  const settings = mergeSettings(inc, loc, effective, plan);
  if (settings && differs(settings, loc.modelSettings)) plan.state.push({ key: STATE_KEYS.modelSettings, value: settings });
  for (const name of ["roleModels", "facts", "workingContext", "humanSources"] as const) {
    if (differs(inc[name], loc[name])) plan.state.push({ key: STATE_KEYS[name], value: inc[name] });
  }
  configWarnings(i.v.manifest, i, plan, config, effective);
}

function configWarnings(manifest: BundleManifest, i: PlanInput, plan: Plan, config: Awaited<ReturnType<typeof loadConfig>>, model: string): void {
  for (const [key, there] of Object.entries(manifest.config)) {
    const here = (config as unknown as Record<string, unknown>)[key];
    if (json(here) !== json(there)) plan.warnings.push(`config differs: ${key} is ${json(there)} on the sending side, ${json(here)} here (config.toml is never copied)`);
  }
  const limit = contextWindow({ fallback: config.contextLimitFallback }, model);
  for (const [id, t] of i.v.transcripts) {
    const estimate = Math.ceil(t.chainBytes / 4);
    if (estimate > limit.limit * 0.8) plan.warnings.push(`${id}: the context (~${estimate} tokens) is close to or over the ${limit.estimated ? "assumed " : ""}${model} window of ${limit.limit}; the first turn here may compact or fail`);
  }
}

/** Tasks from the other machine that were mid-flight there are stopped, never resumed. */
function taskWrites(i: PlanInput, plan: Plan, merged: Task[]): void {
  const before = new Map(i.local.tasks.map(t => [t.id, json(t)]));
  const fromOther = new Set(merged.filter(t => before.get(t.id) !== json(t)).map(t => t.id));
  const stopped = interruptTasks(merged, fromOther, i.now);
  if (stopped.changed.length) plan.lines.push(`tasks: ${stopped.changed.length} unfinished task(s) imported as stopped (attention "unknown": interrupted by session transfer); nothing was restarted`);
  const changed = stopped.tasks.filter(t => before.get(t.id) !== json(t));
  if (!changed.length && stopped.tasks.length === i.local.tasks.length) return;
  plan.tasks = stopped.tasks;
  plan.lines.push(`tasks: ${stopped.tasks.length} total (${fromOther.size} added or advanced from the sending side)`);
}

function questionWrites(i: PlanInput, plan: Plan, merged: Question[]): void {
  const local = new Map([...i.local.questions.values()].map(q => [q.question.id, json(q.question)]));
  let changed = 0;
  for (const q of merged) {
    if (local.get(q.id) === json(q)) continue;
    const bytes = i.v.files.get(`questions/${q.id}.json`);
    if (!bytes || json(i.v.questions.get(q.id)) !== json(q)) throw new Error(`internal: merged question ${q.id} has no source bytes`);
    plan.writes.push({ area: "questions", path: `${q.id}.json`, bytes }); changed++;
  }
  if (changed) plan.lines.push(`questions: ${changed} added or closed from the sending side`);
}

function nameWrites(i: PlanInput, plan: Plan, takenNames: Set<string>): void {
  const wanted = i.name ?? i.v.manifest.name;
  if (!plan.sourceWins || wanted === i.local.name) return;
  if (takenNames.has(wanted)) { plan.lines.push(`name: kept "${i.local.name}" (another project here is already called "${wanted}")`); return; }
  // Not a state change: the name is applied after publication through setDisplayName, which re-checks uniqueness
  // under the folder lock (a direct write here would bypass it).
  plan.name = wanted;
  plan.lines.push(`name: "${wanted}" (from the sending side)`);
}

/** Build the plan. `created`: the project does not exist here yet (new or fork). */
export async function planImport(i: PlanInput, created: boolean, takenNames: Set<string>): Promise<Plan> {
  const plan: Plan = { writes: [], refusals: [], lines: [], warnings: [], incoming: [], heads: {}, sourceWins: created, state: [] };
  const orchestrator = transcriptPlan(i, plan);
  mediaPlan(i, plan);
  const tasks = mergeTasks(i.v.tasks, i.local.tasks);
  const questions = mergeQuestions([...i.v.questions.values()], [...i.local.questions.values()].map(q => q.question));
  plan.refusals.push(...tasks.conflicts, ...questions.conflicts);
  const unit = unitConflict({ transcript: orchestrator, tasks: tasks.direction, questions: questions.direction });
  if (unit) plan.refusals.push(unit);
  plan.lines.push(...tasks.notes, ...questions.notes);
  if (plan.refusals.length) return plan;
  plan.sourceWins = created || orchestrator === "source";
  taskWrites(i, plan, tasks.value);
  questionWrites(i, plan, questions.value);
  await statePlan(i, plan);
  nameWrites(i, plan, takenNames);
  return plan;
}
