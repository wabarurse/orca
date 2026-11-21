import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../config";
import { writeAtomic } from "./conversations";

export type Confirm = { id: string; agent: string; question: string; at: string };
const ConfirmFile = z.object({ id: z.string(), agent: z.string(), question: z.string(), at: z.string() });
const dir = (conversation: string): string => join(paths.daemon(conversation), "confirms");
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;

export async function askUser(conversation: string, agent: string, question: string, signal: AbortSignal, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  await mkdir(dir(conversation), { recursive: true, mode: 0o700 });
  const confirm: Confirm = { id: crypto.randomUUID(), agent, question, at: new Date().toISOString() };
  const file = join(dir(conversation), `${confirm.id}.json`), answer = join(dir(conversation), `${confirm.id}.answer`);
  await writeAtomic(file, JSON.stringify(confirm));
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !signal.aborted) {
      const reply = Bun.file(answer);
      if (await reply.exists()) return (await reply.text()).trim() === "yes";
      await Bun.sleep(250);
    }
    return false;
  } finally { await rm(file, { force: true }); await rm(answer, { force: true }); }
}

export async function pendingConfirms(conversation: string): Promise<Confirm[]> {
  const names = (await readdir(dir(conversation)).catch((): string[] => [])).filter(name => name.endsWith(".json")).sort();
  const out: Confirm[] = [];
  for (const name of names) {
    let raw: unknown;
    try { raw = JSON.parse(await Bun.file(join(dir(conversation), name)).text()); } catch { continue; }
    const confirm = ConfirmFile.safeParse(raw);
    if (confirm.success) out.push(confirm.data);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function answerConfirm(conversation: string, id: string, yes: boolean): Promise<void> {
  await writeAtomic(join(dir(conversation), `${id}.answer`), yes ? "yes" : "no");
}
