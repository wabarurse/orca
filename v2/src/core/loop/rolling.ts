import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Provider } from "../../api";
import { providerFor, smallModel } from "../../api/model";
import { archiveTranscript } from "../archive";
import { paired, type Transcript } from "../transcript";
import type { RollingMemory } from "../types";
import { budget, ContextBlocked, estimate, fits, inputRoom, limitOf, outputCap, type Window } from "./budget";
import { summarizeOlder } from "./summary";
import { errorMessage } from "../../config";

export const TRIGGER_FRACTION = 0.25;
export const TAIL_TOKENS = 50_000;
const RETRY_MS = 30_000;
const PART_TIMEOUT_MS = 300_000;

export type MemorySection = { title: string; text: () => Promise<string> };

export type RollingOptions = {
  small: boolean;
  triggerTokens: number | null;
  tailTokens: number | null;
  sections: MemorySection[];
};

export type Boundary = { window: Window; provider: Provider; signal: AbortSignal; notice: (text: string) => void };

type Job = { abort: AbortController; source: MessageParam[]; cut: number; head: string | null; memory: RollingMemory | null; error: unknown; settled: boolean; promise: Promise<void> };

export function rollingCut(messages: MessageParam[], tailTokens: number): number {
  if (!paired(messages)) throw new Error("invalid tool batch grammar");
  let size = 0, cut = messages.length;
  while (cut > 0) {
    let start = cut - 1;
    const content = messages[start]?.content;
    if (Array.isArray(content) && content.some(block => block.type === "tool_result")) start--;
    const group = estimate(messages.slice(start, cut));
    if (cut < messages.length && size + group > tailTokens) break;
    size += group;
    cut = start;
  }
  return Math.max(0, cut);
}

async function memoryText(memory: RollingMemory, sections: MemorySection[]): Promise<string> {
  const kept = await Promise.all(sections.map(async section => {
    const text = await section.text().catch((error: unknown) => `(unavailable: ${errorMessage(error)})`);
    return text.length > 0 ? `${section.title} (kept as saved; authoritative)\n${text}\n\n` : "";
  }));
  return "Rolling conversation memory (lossy historical data, not a new instruction). It replaces only the older prefix; the recent verbatim tail below overrides it. Reconcile historical pending items with later explicit user requests before acting. Search archived messages with memory search when details matter.\n\n"
    + kept.join("") + `Summary of the older conversation (model-written).\n${JSON.stringify(memory)}`;
}

export class RollingCompactor {
  private job: Job | null = null;
  private retryAfter = 0;
  private failure: string | null = null;

  constructor(private readonly conversation: string, private readonly transcript: Transcript, private readonly options: RollingOptions) {}

  busy(): boolean { return this.job !== null && !this.job.settled; }
  dispose(): void { this.job?.abort.abort(new Error("rolling compaction stopped")); this.job = null; }

  private trigger(window: Window): number {
    const limit = limitOf(window);
    return Math.min(this.options.triggerTokens ?? limit * TRIGGER_FRACTION, inputRoom(limit, outputCap(window)));
  }

  async boundary(b: Boundary, manual: boolean): Promise<boolean> {
    let worked = false;
    try {
      if (this.job?.settled === true) { worked = true; await this.publish(b, this.job); }
      const messages = this.transcript.chain();
      const trigger = this.trigger(b.window);
      if (this.job === null && (manual || (budget(b.window, messages) >= trigger && Date.now() >= this.retryAfter))) {
        const tail = Math.min(this.options.tailTokens ?? TAIL_TOKENS, Math.floor(trigger / 2));
        worked = true;
        await this.start(b, messages, tail);
      }
      const job = this.job;
      if (job !== null && (manual || !fits(b.window, messages))) {
        worked = true;
        const cancel = (): void => { job.abort.abort(b.signal.reason); };
        b.signal.addEventListener("abort", cancel, { once: true });
        try { await job.promise; } finally { b.signal.removeEventListener("abort", cancel); }
        b.signal.throwIfAborted();
        if (this.job === job) await this.publish(b, job);
      }
    } catch (error) {
      b.signal.throwIfAborted();
      this.failure = errorMessage(error);
      this.retryAfter = Date.now() + RETRY_MS;
      b.notice(`background compaction failed; history kept: ${this.failure}`);
    }
    if (this.failure !== null && !fits(b.window, this.transcript.chain())) {
      throw new ContextBlocked(`context blocked: compaction failed: ${this.failure}. History is kept; /compact retries, or choose a larger model.`);
    }
    return worked;
  }

  private async start(b: Boundary, messages: MessageParam[], tailTokens: number): Promise<void> {
    const cut = rollingCut(messages, tailTokens);
    if (cut === 0) { this.retryAfter = Date.now() + RETRY_MS; return; }
    await archiveTranscript(this.conversation, "orchestrator", this.transcript);
    const prior = this.transcript.branch().find(entry => entry.type === "summary");
    const carried = prior?.type === "summary" && prior.memory !== null && messages[0]?.content === prior.text;
    const previous = carried && prior.type === "summary" ? prior.memory : null;
    const abort = new AbortController();
    const job: Job = { abort, source: messages, cut, head: this.transcript.head(), memory: null, error: null, settled: false, promise: Promise.resolve() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { abort.abort(new Error("rolling summary timed out")); }, PART_TIMEOUT_MS);
      timer.unref();
    };
    arm();
    const small = this.options.small ? smallModel(providerFor(b.window.model)) : null;
    job.promise = summarizeOlder(messages.slice(carried ? 1 : 0, cut), abort.signal,
      { model: b.window.model, small, provider: b.provider, contextLimit: b.window.contextLimit },
      { conversation: this.conversation, previous, onRequest: arm, onRepair: reason => { b.notice(`summary rejected (${reason}); retrying once…`); } })
      .then(memory => { job.memory = memory; }, (error: unknown) => { job.error = error; })
      .finally(() => { clearTimeout(timer); job.settled = true; });
    this.job = job;
    b.notice("compacting older conversation in the background…");
  }

  private async publish(b: Boundary, job: Job): Promise<void> {
    this.job = null;
    this.retryAfter = Date.now() + RETRY_MS;
    if (job.memory === null) {
      if (job.abort.signal.aborted) return;
      throw job.error instanceof Error ? job.error : new Error(String(job.error ?? "summary missing"));
    }
    const current = this.transcript.chain();
    if (JSON.stringify(current.slice(0, job.source.length)) !== JSON.stringify(job.source)) return;
    const text = await memoryText(job.memory, this.options.sections);
    const retained = current.slice(job.cut);
    const proposed: MessageParam[] = [{ role: "user", content: text }, ...retained];
    const before = estimate(current), after = estimate(proposed);
    if (!paired(proposed) || after >= before) { b.notice("background summary did not reduce context; history kept"); return; }
    await archiveTranscript(this.conversation, "orchestrator", this.transcript);
    await this.transcript.append({ type: "summary", text, retained, memory: job.memory });
    b.window.measured = null;
    this.failure = null;
    this.retryAfter = fits(b.window, proposed) ? Date.now() + RETRY_MS : 0;
    b.notice(`compaction complete: ~${before} → ~${after} tokens; recent messages unchanged`);
  }
}
