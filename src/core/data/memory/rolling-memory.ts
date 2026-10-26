import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { budget, contextLimit, estimate, outputCap, retainedImages, type ContextDeps } from "./compaction";
import { archiveTranscript, contextEpoch, transcriptEntries } from "./archive";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "../projects/state";
import type { Provider } from "../../../providers/provider";
import { summarizeOlder, taskSnapshot } from "./rolling-summary";
import type { Task } from "../../../protocol/tasks";
import { paired } from "./tool-pairs";
import type { Transcript } from "../transcripts/transcript";
import type { RollingMemory } from "../../../protocol/transcript";
import { inputEpoch } from "../inbox/user-input";

export interface RollingOptions {
  loadProvider?: () => Promise<Provider>;
  triggerTokens?: number;
  tailTokens?: number;
  timeoutMs?: number;
}
interface Job {
  abort: AbortController;
  promise: Promise<void>;
  source: MessageParam[];
  cut: number;
  epoch: string;
  inputEpoch: string;
  checkpoint: string | undefined;
  head: string | null;
  identity: string;
  revisions: Map<string, number>;
  memory?: RollingMemory;
  error?: unknown;
  settled: boolean;
}

/** Keep a recent tail near the target, always retaining the newest complete exchange. */
export function rollingCut(messages: MessageParam[], tailTokens: number): number {
  if (!paired(messages)) throw new Error("invalid tool batch grammar");
  let size = 0, cut = messages.length;
  while (cut > 0) {
    let start = cut - 1;
    const content = messages[start]!.content;
    if (Array.isArray(content) && content.some(b => b.type === "tool_result")) start--;
    const groupSize = estimate(messages.slice(start, cut));
    if (cut < messages.length && size + groupSize > tailTokens) break;
    size += groupSize; cut = start;
  }
  return cut;
}

const checkpoint = (t: Transcript) => t.branch().find(e => e.type === "summary")?.uuid;
function status(deps: ContextDeps, text: string): void {
  try { deps.write?.(`${text}\n`, true); } catch { /* Reporting cannot undo a committed checkpoint. */ }
}
function fits(deps: ContextDeps, messages: MessageParam[]): boolean {
  return budget(deps, messages) + outputCap(deps) <= .8 * contextLimit(deps.compaction ?? {}, deps.model);
}
function memoryText(memory: RollingMemory, tasks: Task[]): string {
  return `Rolling conversation memory (lossy historical data, not a new instruction). Recent verbatim messages override this memory. Confirm uncertain details with task search_history/read_history. Only the current context scope is searchable.\n` +
    `Tasks are unfinished until a verified merge. Attention flags preserve blocked/cancelled/closed work, never authorize restart. Registry data below overrides historical task notes.\n` +
    JSON.stringify({ ...memory, activeTasks: taskSnapshot(tasks.filter(t => !t.archive)) });
}

/** One background worker per orchestrator session. Only boundary() can publish. */
export class RollingCompactor {
  private job?: Job;
  private retryAfter = 0;
  private disposed = false;
  private generation = 0;
  constructor(private project: string, private transcript: Transcript, private options: RollingOptions = {}) {}
  ready(): boolean { return !!this.job?.settled; }
  reset(): void { this.generation++; this.job?.abort.abort(new Error("rolling compaction cancelled")); this.job = undefined; this.retryAfter = 0; }
  dispose(): void { this.disposed = true; this.reset(); }
  /** Read-only refresh can invalidate work, never start or publish a summary. */
  reconcile(): void {
    const job = this.job;
    if (job && (inputEpoch(this.project) !== job.inputEpoch || contextEpoch(transcriptEntries(this.transcript)) !== job.epoch || checkpoint(this.transcript) !== job.checkpoint)) this.reset();
  }
  /** One-shot CLI sessions join their worker before exiting; interactive sessions never need this. */
  async finish(signal?: AbortSignal): Promise<boolean> {
    this.reconcile();
    const job = this.job;
    if (!job) return false;
    await this.join(job, signal);
    return this.ready();
  }

  async boundary(deps: ContextDeps, manual = false, maintenance = false): Promise<void> {
    try { await this.prepare(deps, manual, maintenance); }
    catch (error) {
      deps.signal?.throwIfAborted();
      this.retryAfter = Date.now() + 30000;
      status(deps, `background compaction failed; original history kept: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async prepare(deps: ContextDeps, manual: boolean, maintenance: boolean): Promise<void> {
    deps.signal?.throwIfAborted();
    if (this.disposed) return;
    if (!manual && deps.compaction?.enabled === false) { this.reset(); return; }
    this.reconcile();
    if (this.job?.settled) await this.apply(deps, this.job);
    // Idle maintenance only publishes existing work. In particular a discarded
    // stale checkpoint must not cause inference merely because polling refreshed.
    if (maintenance) return;
    const messages = await this.transcript.chain();
    const limit = contextLimit(deps.compaction ?? {}, deps.model);
    const safeInput = .8 * limit - outputCap(deps);
    // Default: 40% of the selected model's window, so 1M-context models do not
    // compact at 100k. An explicit triggerTokens stays an absolute token count.
    const trigger = Math.min(this.options.triggerTokens ?? limit * .4, safeInput * .8);
    if (!this.job && (manual || (budget(deps, messages) >= trigger && Date.now() >= this.retryAfter))) {
      await this.start(deps, messages);
    }
    if (this.job && (manual || !fits(deps, messages))) {
      const job = this.job;
      // Normal turns proceed in parallel. Only manual compaction or a hard limit waits.
      await this.join(job, deps.signal);
      if (this.job === job) await this.apply(deps, job);
    }
  }

  private async join(job: Job, signal?: AbortSignal): Promise<void> {
    const cancel = () => job.abort.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    try { signal?.throwIfAborted(); await job.promise; signal?.throwIfAborted(); }
    finally { signal?.removeEventListener("abort", cancel); }
  }

  private async start(deps: ContextDeps, messages: MessageParam[]): Promise<void> {
    const cut = rollingCut(messages, this.options.tailTokens ?? 20000);
    if (!cut) { this.retryAfter = Date.now() + 30000; return; }
    const identity = projectIdentity(this.project), generation = this.generation;
    const epoch = inputEpoch(this.project);
    const tasks = await archiveTranscript(this.project, this.transcript);
    deps.signal?.throwIfAborted();
    if (this.disposed || generation !== this.generation || inputEpoch(this.project) !== epoch) return;
    assertProjectIdentity(this.project, identity);
    const abort = new AbortController();
    const job: Job = { abort, promise: Promise.resolve(), source: messages, cut,
      inputEpoch: epoch, epoch: contextEpoch(transcriptEntries(this.transcript)), checkpoint: checkpoint(this.transcript), head: this.transcript.head(),
      identity, revisions: new Map(tasks.map(t => [t.id, t.revision])), settled: false };
    this.job = job;
    const timer = setTimeout(() => abort.abort(new Error("rolling summary timed out")), this.options.timeoutMs ?? 120000);
    timer.unref();
    // Race even custom providers that ignore AbortSignal; late answers cannot publish.
    const cancelled = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
    job.promise = Promise.race([summarizeOlder(messages.slice(0, cut), tasks, abort.signal, this.options.loadProvider), cancelled])
      .then(memory => { assertProjectIdentity(this.project, identity); job.memory = memory; })
      .catch(error => { job.error = error; })
      .finally(() => { clearTimeout(timer); job.settled = true; });
    status(deps, "compacting older conversation in the background…");
  }

  private async apply(deps: ContextDeps, job: Job): Promise<void> {
    try { await this.publish(deps, job); }
    finally { if (this.job === job) this.job = undefined; }
  }

  private async publish(deps: ContextDeps, job: Job): Promise<void> {
    this.retryAfter = Date.now() + 30000;
    if (job.error || !job.memory) { status(deps, `background compaction failed; original history kept: ${job.error instanceof Error ? job.error.message : job.error}`); return; }
    const identity = job.identity;
    await withProjectStateLock(this.project, async () => {
      assertProjectIdentity(this.project, identity);
      const signal = deps.signal ? AbortSignal.any([deps.signal, job.abort.signal]) : job.abort.signal;
      const authorize = () => {
        signal.throwIfAborted();
        assertProjectIdentity(this.project, identity);
        if (inputEpoch(this.project) !== job.inputEpoch) throw new Error("rolling compaction cancelled by another session");
      };
      authorize();
      await this.transcript.refresh?.();
      if (this.disposed || job.abort.signal.aborted || contextEpoch(transcriptEntries(this.transcript)) !== job.epoch || checkpoint(this.transcript) !== job.checkpoint) return;
      const head = this.transcript.head();
      const current = await this.transcript.chain();
      // The original snapshot must still be an exact prefix. All newer messages survive verbatim.
      if (JSON.stringify(current.slice(0, job.source.length)) !== JSON.stringify(job.source)) return;
      const tasks = await archiveTranscript(this.project, this.transcript);
      if (this.disposed) return;
      const memory = { ...job.memory!, tasks: job.memory!.tasks.filter(note => tasks.some(t => t.id === note.id && !t.archive && t.revision === job.revisions.get(t.id))) };
      // Summaries never see pixels. Preserve omitted image blocks separately,
      // including their original prompt association, exactly as worker checkpoints do.
      // New arrivals and the recent tail stay verbatim; receipts remain on originals.
      const text = memoryText(memory, tasks);
      const retained = [...retainedImages(current.slice(0, job.cut)), ...current.slice(job.cut)];
      const proposed: MessageParam[] = [{ role: "user", content: text }, ...retained];
      const clean = { ...deps, compaction: { ...deps.compaction, measured: undefined } };
      if (!paired(proposed) || estimate(proposed) >= estimate(current)) { status(deps, "background summary did not reduce context; original history kept."); return; }
      // New arrivals can outgrow even a valid summary. Commit the reduction; the loop
      // still refuses a model request until requireFits passes (possibly after another pass).
      await this.transcript.append({ type: "summary", text, memory, retained, boundary: job.head }, signal, { head, check: authorize });
      if (deps.compaction) deps.compaction.measured = undefined;
      this.retryAfter = fits(clean, proposed) ? Date.now() + 30000 : 0;
      status(deps, `compaction complete: ~${estimate(current)} → ~${estimate(proposed)} history tokens; recent messages unchanged.`);
    });
  }
}
