// A project's stable cross-machine identity: projects/<id>/session.json.
//
// The folder id, its inode and its birth time are machine-local and change when a
// project is moved or recreated. `sessionId` is a random UUID minted lazily the
// first time something needs a stable identity (the first image save, or the first
// session export) and never changes afterwards, not even on /rename. Image-ref
// scope (core/data/images) and session transfer (core/session) derive
// from it. Other keys in the file (the sync ledger) are preserved by writers.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";

export interface SessionFile { version: 1; sessionId: string; [key: string]: unknown }
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const validSessionId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const file = (project: string) => join(paths.project(project), "session.json");

function checkId(project: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw new Error("invalid project id");
}

/** The saved record, undefined when none was minted yet. Malformed files throw: never mint over them. */
export function readSession(project: string): SessionFile | undefined {
  checkId(project);
  let raw: string;
  try { raw = readFileSync(file(project), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !validSessionId(value.sessionId)) throw new Error(`invalid session record for ${project}`);
  return value;
}

/**
 * The stable id, minted on first use. Minting is lock-free and race-safe: the record is
 * written to a temporary file and hard-linked into place, which fails if another
 * process won, so every caller observes the same id and no reader sees a partial file.
 */
export async function ensureSessionId(project: string, id: string = randomUUID()): Promise<string> {
  const existing = readSession(project);
  if (existing) return existing.sessionId;
  if (!validSessionId(id)) throw new Error("invalid session id");
  const temp = `${file(project)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, sessionId: id }) + "\n", { flag: "wx", mode: 0o600 });
    try { await link(temp, file(project)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temp, { force: true }); }
  return readSession(project)!.sessionId;
}

/** Atomically replace session.json (caller holds the project-state lock); sessionId must not change. */
export async function writeSession(project: string, next: SessionFile): Promise<void> {
  const old = readSession(project);
  if (old && old.sessionId !== next.sessionId) throw new Error("a session id never changes");
  await mkdir(paths.project(project), { recursive: true });
  const temp = `${file(project)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, file(project));
  } finally { await rm(temp, { force: true }); }
}
