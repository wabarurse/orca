// A project's stable cross-machine identity: projects/<id>/session.json.
//
// The folder id, its inode and its birth time are machine-local and change when a
// project is moved or recreated. `sessionId` is a random UUID minted lazily the
// first time something needs a stable identity (the first image save) and never
// changes afterwards, not even on /rename. Image-ref scope (core/data/images)
// derives from it. Other keys in the file are preserved by writers.

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
 * Where hard links are unsupported it falls back to an exclusive (`wx`) create of the final file.
 */
export async function ensureSessionId(project: string, id: string = randomUUID()): Promise<string> {
  const existing = readSession(project);
  if (existing) return existing.sessionId;
  if (!validSessionId(id)) throw new Error("invalid session id");
  const temp = `${file(project)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, sessionId: id }) + "\n", { flag: "wx", mode: 0o600 });
    try { await link(temp, file(project)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return readSession(project)!.sessionId;
      // No hard links on this filesystem (FAT, some network mounts): create the final file exclusively. Still
      // first-writer-wins; only a reader racing the write could see a partial file, and readSession then throws
      // rather than minting over it.
      await writeFile(file(project), JSON.stringify({ version: 1, sessionId: id }) + "\n", { flag: "wx", mode: 0o600 }).catch(e => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; });
    }
  } finally { await rm(temp, { force: true }); }
  return readSession(project)!.sessionId;
}
