import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import type { Message } from "../../../protocol";
import { put } from "./inbox";

/** Durable change detection and outbox. Replay uses the same delivery identity. */
export async function observe(project: string, key: string, value: unknown, text: string, options: { defer?: boolean; existingOnly?: boolean } = {}): Promise<void> {
  const dir = join(paths.runtimeProject(project), "observations");
  await mkdir(dir, { recursive: true });
  const file = join(dir, createHash("sha256").update(key).digest("hex") + ".json");
  await withStorageLock(`${file}.lock`, async () => {
    type State = { value: string; message: Omit<Message, "ts">; delivered: boolean };
    let old: State | undefined;
    try { old = await Bun.file(file).json(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const save = async (state: State) => { const tmp = `${file}.${crypto.randomUUID()}`; await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, file); };
    if (old && !old.delivered && !options.defer) { await put(project, "orchestrator", old.message); old.delivered = true; await save(old); }
    if (options.existingOnly || old?.value === JSON.stringify(value)) return;
    const next: State = { value: JSON.stringify(value), delivered: false, message: { from: "runtime", text,
      event: { id: crypto.randomUUID(), topic: key, sequence: (old?.message.event?.sequence ?? 0) + 1, state: "changed", at: new Date().toISOString() } } };
    await save(next);
    if (!options.defer) { await put(project, "orchestrator", next.message); next.delivered = true; await save(next); }
  });
}
