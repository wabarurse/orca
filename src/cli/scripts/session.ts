// `orca session ...`: the command layer over export/import. Everything touching the outside world is injected
// (stdin/stdout, the ssh boundary, liveness) so tests run whole transfers in one process.
//
//   orca session ls [host]                     projects here, or on host
//   orca session push <project> <host>         send a project to host (runs `orca session receive` there)
//   orca session pull <project> <host>         fetch a project from host (runs `orca session send` there)
//   orca session export <project> <file>       write a bundle file (offline)
//   orca session import <file>                 read a bundle file (offline)
//   orca session recover                       settle an import that was interrupted (rolls back or completes it)
//   orca session send <project> | receive      internal stdin/stdout endpoints used over ssh
// Flags: --as <name>, --checkout <dir> (the checkout on the machine that RECEIVES), --adopt, --dry-run, --force (export).
// The project argument is a session id, a display name or a folder id, in that order. This is unrelated to `orca pull`,
// which updates orca itself.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { exportSession, importSession, MAGIC, realDeps, recoverSessions, resolveSelector, sessionRows, TransferRefused, type ImportReport, type SessionRow, type TransferDeps } from "../../core/session";

export interface SshResult { code: number; out: Buffer; err: string }
/** Run `ssh <host> <remote command>` with stdin. Tests replace it with an in-process peer. */
export type Transport = (host: string, remoteCommand: string, stdin?: Uint8Array) => Promise<SshResult>;
export interface SessionIO { stdin: () => Promise<Buffer>; out: (bytes: Uint8Array | string) => void; err: (text: string) => void }
export interface SessionEnv { io: SessionIO; transport: Transport; deps: TransferDeps; remoteOrca: string }

/** Non-interactive and bounded: no password prompt, no hang on an unreachable host, a hard ceiling on the whole transfer. */
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
const SSH_LIMIT_MS = 30 * 60 * 1000;

export const sshTransport: Transport = async (host, remoteCommand, stdin) => {
  if (host.startsWith("-") || /\s/.test(host)) throw new Error(`invalid host ${JSON.stringify(host)}`);
  const child = Bun.spawn(["ssh", ...SSH_OPTIONS, "--", host, remoteCommand], { stdin: stdin ? Buffer.from(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), SSH_LIMIT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    return { code, out: Buffer.from(out), err };
  } finally { clearTimeout(timer); }
};

export const realEnv = (): SessionEnv => ({
  io: { stdin: async () => Buffer.from(await new Response(Bun.stdin.stream()).arrayBuffer()), out: b => void process.stdout.write(b), err: t => void process.stderr.write(t) },
  transport: sshTransport, deps: realDeps(), remoteOrca: process.env.ORCA_REMOTE_COMMAND || "orca",
});

export const USAGE = `  orca session ls [host]
  orca session push <project> <host> [--as <name>] [--checkout <dir on host>] [--adopt] [--dry-run]
  orca session pull <project> <host> [--as <name>] [--checkout <dir here>] [--adopt] [--dry-run]
  orca session export <project> <file> [--force] [--dry-run]
  orca session import <file> [--as <name>] [--checkout <dir>] [--adopt] [--dry-run]
  orca session recover`;

interface Args { positional: string[]; as?: string; checkout?: string; dryRun: boolean; json: boolean; adopt: boolean; force: boolean; peer?: string }
function parse(argv: string[]): Args {
  const out: Args = { positional: [], dryRun: false, json: false, adopt: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!, value = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`); return v; };
    if (a === "--as") out.as = value();
    else if (a === "--checkout") out.checkout = value();
    else if (a === "--peer") out.peer = value();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--adopt") out.adopt = true;
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const remote = (env: SessionEnv, sub: string, args: string[]) => [env.remoteOrca, "session", sub, ...args.map(quote)].join(" ");
const flagsFor = (a: Args, keep: ("as" | "checkout" | "dryRun" | "adopt")[]) => [
  ...(keep.includes("as") && a.as ? ["--as", a.as] : []), ...(keep.includes("checkout") && a.checkout ? ["--checkout", a.checkout] : []),
  ...(keep.includes("adopt") && a.adopt ? ["--adopt"] : []), ...(keep.includes("dryRun") && a.dryRun ? ["--dry-run"] : []),
];

/** ssh may print a banner before our bytes; the bundle starts at its magic. */
const bundleFrom = (out: Buffer) => { const at = out.indexOf(MAGIC); return at < 0 ? out : out.subarray(at); };
const RESULT = "ORCA-SESSION-RESULT ";
type Outcome = { ok: true; report: ImportReport } | { ok: false; reasons: string[] };

function resultFrom(r: SshResult, what: string): Outcome {
  const line = r.out.toString("utf8").split("\n").reverse().find(l => l.startsWith(RESULT));
  if (!line) throw new Error(`${what} gave no result (exit ${r.code}). Is orca with \`session\` support installed there, and on the PATH of non-interactive ssh (set ORCA_REMOTE_COMMAND)?\n${r.err.trim()}`);
  return JSON.parse(line.slice(RESULT.length)) as Outcome;
}

function show(env: SessionEnv, report: ImportReport, label: string): void {
  const say = (s: string) => env.io.err(s + "\n");
  say(`${report.dryRun ? "[dry run] " : ""}${label}: ${report.outcome} ${report.project} (session ${report.sessionId})`);
  for (const l of report.lines) say(`  ${l}`);
  for (const w of report.warnings) say(`  note: ${w}`);
  if (report.backup) say(`  replaced files were backed up to ${report.backup}`);
  if (report.dryRun) say("  dry run: nothing was written");
}
function showRefusal(env: SessionEnv, reasons: string[]): void {
  env.io.err(`transfer refused, nothing was written:\n${reasons.map(r => `  - ${r}`).join("\n")}\n`);
}
/** Notes the other side printed to its stderr (export warnings, its own notices): never swallowed. */
const relay = (env: SessionEnv, err: string) => { if (err.trim()) env.io.err(err.endsWith("\n") ? err : err + "\n"); };

const table = (rows: SessionRow[]) => rows.length
  ? rows.map(r => `${r.name.padEnd(24)} ${r.id.padEnd(12)} ${(r.sessionId ?? "(not exported yet)").padEnd(36)} ${String(r.entries).padStart(6)} entries  ${r.updated ?? "-"}`).join("\n") + "\n"
  : "no projects\n";

async function receive(a: Args, env: SessionEnv): Promise<number> {
  try {
    const report = await importSession(await env.io.stdin(), env.deps, { as: a.as, checkout: a.checkout, adopt: a.adopt, dryRun: a.dryRun, peer: a.peer ?? "unknown" });
    env.io.out(`${RESULT}${JSON.stringify({ ok: true, report } satisfies Outcome)}\n`);
    return 0;
  } catch (error) {
    const reasons = error instanceof TransferRefused ? error.reasons : [error instanceof Error ? error.message : String(error)];
    env.io.out(`${RESULT}${JSON.stringify({ ok: false, reasons } satisfies Outcome)}\n`);
    return 1;
  }
}

async function exportBundle(selector: string, env: SessionEnv, dryRun: boolean) {
  const result = await exportSession(await resolveSelector(selector), env.deps, { dryRun });
  for (const w of result.warnings) env.io.err(`  note: ${w}\n`);
  env.io.err("  note: transcripts can contain secrets that were pasted into the conversation, and absolute paths of this machine; the bundle carries them unencrypted (ssh encrypts the transport)\n");
  return result;
}

async function finish(env: SessionEnv, outcome: Outcome, label: string): Promise<number> {
  if (outcome.ok) { show(env, outcome.report, label); return 0; }
  showRefusal(env, outcome.reasons);
  return 1;
}

type Handler = (a: Args, env: SessionEnv) => Promise<number>;
const [first, second] = [(a: Args) => a.positional[0]!, (a: Args) => a.positional[1]!];
const need = (a: Args, sub: string, n: number) => { if (a.positional.length !== n) throw new Error(`expected ${n} argument(s) for session ${sub}`); };

async function ls(a: Args, env: SessionEnv): Promise<number> {
  if (a.positional.length > 1) throw new Error("expected session ls [host]");
  const host = a.positional[0];
  if (!host) { const rows = await sessionRows(); env.io.out(a.json ? JSON.stringify(rows) + "\n" : table(rows)); return 0; }
  const r = await env.transport(host, remote(env, "ls", ["--json"]));
  if (r.code !== 0) throw new Error(`ssh ${host}: ${r.err.trim() || `exit ${r.code}`}`);
  const rows = JSON.parse(r.out.toString("utf8").split("\n").reverse().find(l => l.startsWith("[")) ?? "[]");
  env.io.out(a.json ? JSON.stringify(rows) + "\n" : table(rows));
  return 0;
}
async function send(a: Args, env: SessionEnv): Promise<number> {
  need(a, "send", 1);
  env.io.out((await exportBundle(first(a), env, a.dryRun)).bundle);
  return 0;
}
/** A bundle file holds the whole conversation: created private (0600) and never silently overwritten. */
async function exportFile(a: Args, env: SessionEnv): Promise<number> {
  need(a, "export", 2);
  const result = await exportBundle(first(a), env, a.dryRun);
  if (!a.dryRun) {
    await writeFile(second(a), result.bundle, { mode: 0o600, flag: a.force ? "w" : "wx" }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${second(a)} already exists; pass --force to overwrite it`);
      throw error;
    });
    await chmod(second(a), 0o600);
  }
  env.io.err(`${a.dryRun ? "[dry run] would write" : "wrote"} ${second(a)} (${result.bundle.length} bytes, ${result.manifest.transcripts.length} transcripts)\n`);
  return 0;
}
async function importFile(a: Args, env: SessionEnv): Promise<number> {
  need(a, "import", 1);
  const report = await importSession(await readFile(first(a)), env.deps, { as: a.as, checkout: a.checkout, adopt: a.adopt, dryRun: a.dryRun, peer: a.peer ?? `file:${first(a)}` });
  show(env, report, "imported");
  return 0;
}
async function push(a: Args, env: SessionEnv): Promise<number> {
  need(a, "push", 2);
  const { bundle } = await exportBundle(first(a), env, a.dryRun);
  const r = await env.transport(second(a), remote(env, "receive", [...flagsFor(a, ["as", "checkout", "adopt", "dryRun"]), "--peer", env.deps.hostname()]), bundle);
  return finish(env, resultFrom(r, `ssh ${second(a)}`), `pushed to ${second(a)}`);
}
async function pull(a: Args, env: SessionEnv): Promise<number> {
  need(a, "pull", 2);
  const r = await env.transport(second(a), remote(env, "send", [first(a), ...flagsFor(a, ["dryRun"])]));
  if (r.code !== 0 || r.out.indexOf(MAGIC) < 0) throw new Error(`${second(a)} could not send ${first(a)}: ${(r.err.trim() || r.out.toString("utf8").trim()) || `exit ${r.code}`}`);
  relay(env, r.err.split("\n").map(l => l.replace(/^\s*note:/, `  note (from ${second(a)}):`)).join("\n"));
  const report = await importSession(bundleFrom(r.out), env.deps, { as: a.as, checkout: a.checkout, adopt: a.adopt, dryRun: a.dryRun, peer: second(a) });
  show(env, report, `pulled from ${second(a)}`);
  return 0;
}
async function recover(a: Args, env: SessionEnv): Promise<number> {
  need(a, "recover", 0);
  const done = await recoverSessions();
  env.io.err(done.length ? done.map(l => `${l}\n`).join("") : "no interrupted imports\n");
  return 0;
}
const COMMANDS: Record<string, Handler> = {
  ls, send, receive: (a, env) => { need(a, "receive", 0); return receive(a, env); }, export: exportFile, import: importFile, push, pull, recover,
};
function run(sub: string, a: Args, env: SessionEnv): Promise<number> {
  const handler = Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!handler) throw new Error(`unknown session command: ${sub}`);
  return handler(a, env);
}

/** Exit code for `orca session <argv>`; errors and refusals are written to io.err, never thrown. */
export async function runSession(argv: string[], env: SessionEnv): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (!sub) throw new Error("expected a session command");
    return await run(sub, parse(rest), env);
  } catch (error) {
    if (error instanceof TransferRefused) showRefusal(env, error.reasons);
    else env.io.err(`orca session: ${error instanceof Error ? error.message : String(error)}\nusage:\n${USAGE}\n`);
    return 1;
  }
}
