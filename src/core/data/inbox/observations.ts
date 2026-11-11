import { createHash } from "node:crypto";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import type { Message } from "../../../protocol";
import { put } from "./inbox";

type State = { value: string; message: Omit<Message, "ts">; delivered: boolean };
const directory = (project: string) => join(paths.runtimeProject(project), "observations");
const filename = (project: string, key: string) => join(directory(project), createHash("sha256").update(key).digest("hex") + ".json");
const read = async <T>(file: string): Promise<T | undefined> => Bun.file(file).json().catch(e => { if (e.code !== "ENOENT") throw e; });
async function save(file: string, state: unknown): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, file);
}

/** Durable change detection and outbox. Replay uses the same delivery identity. */
export async function observe(project: string, key: string, value: unknown, text: string, options: { defer?: boolean; existingOnly?: boolean; initialSilent?: boolean; beforePublish?: () => void; normalize?: (value: unknown, previous?: unknown) => unknown } = {}): Promise<void> {
  const dir = directory(project);
  await mkdir(dir, { recursive: true });
  const file = filename(project, key);
  await withStorageLock(`${file}.lock`, async () => {
    const old = await read<State>(file);
    if (old && !old.delivered && !options.defer) { await put(project, "orchestrator", old.message, options.beforePublish); old.delivered = true; await save(file, old); }
    const previous = old ? JSON.parse(old.value) : undefined;
    if (options.normalize) value = options.normalize(value, previous);
    if (options.existingOnly || (old && JSON.stringify(options.normalize ? options.normalize(previous) : previous) === JSON.stringify(value))) return;
    const next: State = { value: JSON.stringify(value), delivered: !old && !!options.initialSilent, message: { from: "runtime", text,
      event: { id: crypto.randomUUID(), topic: key, sequence: (old?.message.event?.sequence ?? 0) + 1, state: "changed", at: new Date().toISOString() } } };
    await save(file, next);
    if (!options.defer && !next.delivered) { await put(project, "orchestrator", next.message, options.beforePublish); next.delivered = true; await save(file, next); }
  });
}

/** Only undelivered observations are discarded when their work is cancelled. */
export async function discardObservation(project: string, key: string): Promise<void> {
  const file = filename(project, key);
  if (!await Bun.file(file).exists()) return;
  await withStorageLock(`${file}.lock`, async () => {
    const state = await read<State>(file);
    if (state && !state.delivered) { state.delivered = true; await save(file, state); }
  });
}

/** One inbox message per observer pass. Persist the batch before delivery and
 * retain its identity across crashes, including a partially acknowledged batch. */
export async function flushObservations(project: string, keys: string[], beforePublish: () => void, accept: (key: string) => boolean = () => true): Promise<void> {
  const dir = directory(project);
  await mkdir(dir, { recursive: true });
  const journal = join(dir, "batch.json");
  type Batch = { message: Omit<Message, "ts">; entries: { key: string; id: string; text: string }[] };
  await withStorageLock(`${journal}.lock`, async () => {
    const deliver = async (batch: Batch) => {
      const eligible = batch.entries.filter(entry => accept(entry.key));
      if (eligible.length) await put(project, "orchestrator", { ...batch.message, text: eligible.map(entry => entry.text).join("\n") }, beforePublish);
      for (const entry of batch.entries) {
        const file = filename(project, entry.key);
        await withStorageLock(`${file}.lock`, async () => {
          const state = await read<State>(file);
          if (state?.message.event?.id === entry.id) { state.delivered = true; await save(file, state); }
        });
      }
      await unlink(journal);
    };
    const interrupted = await read<Batch>(journal);
    if (interrupted) await deliver(interrupted);
    const pending: { key: string; state: State }[] = [];
    for (const key of new Set(keys)) {
      const state = await read<State>(filename(project, key));
      if (state && !state.delivered) pending.push({ key, state });
    }
    if (!pending.length) return;
    beforePublish();
    const batch: Batch = { entries: pending.map(({ key, state }) => ({ key, id: state.message.event!.id, text: state.message.text })),
      message: { from: "runtime", text: pending.map(p => p.state.message.text).join("\n"),
        event: { id: crypto.randomUUID(), topic: "pr-batch", sequence: 1, state: "changed", at: new Date().toISOString() } } };
    await save(journal, batch);
    await deliver(batch);
  });
}
