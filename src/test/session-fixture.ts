// Two throwaway "machines" for session-transfer tests: each has its own ORCA_HOME and a plain folder standing in for its checkout.
// `at(machine, fn)` runs fn with that machine's ORCA_HOME selected (orca reads it lazily).
// Fake data only: no real ~/.orca, no providers, no tmux, no network.

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config";
import { initializeWorkspace, setDisplayName, withProjectStateLock } from "../core/data/projects";
import { open } from "../core/data/transcripts";
import type { TransferDeps } from "../core/session";
import { runSession, type SessionEnv, type Transport } from "../cli/scripts/session";

export interface Machine { name: string; home: string; repo: string; dir: string }
export const ORIGIN = "https://example.invalid/org/repo.git";
const created: string[] = [];
const origins = new Map<string, string | null>();


export async function machine(name: string, origin: string | null = ORIGIN): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `orca-session-${name}-`)); created.push(dir);
  const home = join(dir, "home"), repo = join(dir, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  origins.set(realpathSync(repo), origin);
  return { name, home, repo, dir };
}
export const cleanup = () => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** Layout safety refuses group-writable state directories, so the machine runs under umask 022 whatever the environment's is. */
export async function at<T>(m: Machine, fn: () => Promise<T> | T): Promise<T> {
  const old = process.env.ORCA_HOME, mask = process.umask(0o022), which = Bun.which;
  process.env.ORCA_HOME = m.home;
  // A machine here is a plain folder, never a git checkout: nothing in these tests may spawn a process (a hung child
  // cannot be killed in every environment), so the project is bound as a directory project and git is "not installed".
  (Bun as { which: unknown }).which = (name: string, options?: unknown) => name === "git" ? null : (which as (n: string, o?: unknown) => string | null)(name, options);
  try { return await fn(); } finally { (Bun as { which: unknown }).which = which; process.umask(mask); if (old === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = old; }
}

/** A bound project on `m` with the given display name (omit for none). */
export async function project(m: Machine, id: string, name?: string): Promise<string> {
  return at(m, async () => {
    await withProjectStateLock(id, () => initializeWorkspace(id, m.repo));
    if (name) await setDisplayName(id, name);
    return id;
  });
}

/** Append alternating user/assistant text messages to a transcript (default: the orchestrator's). */
export async function say(m: Machine, id: string, texts: string[], agent = "orchestrator"): Promise<void> {
  await at(m, async () => {
    const t = open(paths.transcript(id, agent));
    for (const [i, text] of texts.entries()) await t.append({ type: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: text } });
  });
}
export const read = (m: Machine, id: string, rel: string) => at(m, () => Bun.file(join(paths.project(id), rel)).text());
export const exists = (m: Machine, id: string, rel: string) => at(m, () => Bun.file(join(paths.project(id), rel)).exists());

export const quiet = (over: Partial<TransferDeps> = {}): TransferDeps => ({
  live: async () => [], alive: () => false, now: () => new Date("2026-01-02T03:04:05.000Z"), hostname: () => "test-host", origin: async directory => { try { return origins.get(realpathSync(directory)) ?? null; } catch { return null; } }, ...over,
});

/** The ssh boundary replaced by an in-process peer: runs `orca session <sub> ...` on machine `peer`, recording the command it was asked to run. */
export function loopback(peer: Machine, deps: TransferDeps = quiet({ hostname: () => peer.name }), log: string[] = []): Transport {
  return async (host, command, stdin) => {
    log.push(`${host}: ${command}`);
    const words = [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(m => m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]!);
    expect(words.slice(0, 2)).toEqual(["orca", "session"]);
    const out: (Uint8Array | string)[] = [], err: string[] = [];
    const env: SessionEnv = {
      io: { stdin: async () => Buffer.from(stdin ?? new Uint8Array()), out: b => void out.push(b), err: t => void err.push(t) },
      transport: async () => { throw new Error("peer does not ssh onward"); }, deps, remoteOrca: "orca",
    };
    const code = await at(peer, () => runSession(words.slice(2), env));
    return { code, out: Buffer.concat(out.map(o => Buffer.from(o))), err: err.join("") };
  };
}

/** Run `orca session ...` on machine `m`; returns exit code and what it wrote to stderr/stdout. */
export async function session(m: Machine, argv: string[], opts: { transport?: Transport; deps?: TransferDeps; stdin?: Uint8Array } = {}) {
  const out: (Uint8Array | string)[] = [], err: string[] = [];
  const env: SessionEnv = {
    io: { stdin: async () => Buffer.from(opts.stdin ?? new Uint8Array()), out: b => void out.push(b), err: t => void err.push(t) },
    transport: opts.transport ?? (async () => { throw new Error("no ssh in this test"); }),
    deps: opts.deps ?? quiet({ hostname: () => m.name }), remoteOrca: "orca",
  };
  const code = await at(m, () => runSession(argv, env));
  return { code, out: Buffer.concat(out.map(o => Buffer.from(o))), err: err.join("") };
}

/**
 * Hold a storage lock as another live process would (owner pid 1: signalable-or-EPERM, so never "verifiably dead"),
 * without relying on this process being signalable. Returns the release.
 */
export function holdLock(path: string): () => void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 1, since: new Date().toISOString() }) + "\n");
  return () => rmSync(path, { recursive: true, force: true });
}
