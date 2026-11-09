// Session-transfer bundle: a manifest plus an allowlisted set of project files in one byte stream.
//
// Wire format: MAGIC, then records of `u32be headerLength, header JSON {path,size}, size payload bytes`,
// ending with a record whose headerLength is 0. The first record is manifest.json. There is no compression
// and no external tar: tests pipe bundles through memory, ssh pipes them through `orca session send|receive`.
//
// HONESTY: orca keeps no provider-side session (requests are stateless: store:false, no previous_response_id).
// A transferred session "resumes" by re-sending the stored chain. The prompt cache is NOT transferred (the
// first request after a move is a cache miss) and the destination's system prompt, model access and config
// may differ. Transcripts can contain secrets pasted into the conversation; the bundle is not encrypted.

import { createHash } from "node:crypto";
import pkg from "../../../package.json";

/** Version of the on-disk layout this checkout reads and writes (config/layout.ts: layout.json version). */
export const LAYOUT_VERSION = 3;
export const MANIFEST_VERSION = 1;
/** tasks: the task records inside tasks.json (the ledger's `Task`); state: state.json. */
export const SCHEMAS = { tasks: 1, state: 1 } as const;
export const orcaVersion: string = pkg.version;
export const SCOPE_PLACEHOLDER = "0".repeat(64);
export const MAGIC = Buffer.from("ORCA-SESSION-BUNDLE\n");
export const MAX_FILE = 1024 ** 3;
export const MAX_TOTAL = 8 * 1024 ** 3;
export const MAX_FILES = 200_000;

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface TranscriptRecord {
  id: string;
  entries: number;
  /** Digest of the canonical line ledger (image scopes replaced by SCOPE_PLACEHOLDER). */
  ledgerDigest: string;
  /** sha256 of the exact JSON of transcript.chain() over the bundled file at export. */
  contextDigest: string;
  chainMessages: number;
}
export interface BundleManifest {
  manifestVersion: number;
  orcaVersion: string;
  layoutVersion: number;
  schemas: { tasks: number; state: number };
  sessionId: string;
  name: string;
  folderId: string;
  host: string;
  exportedAt: string;
  /** Materialized from the source project: its effective model and the settings for that model. */
  model: { effective: string; settings: Record<string, unknown> };
  /** Informational only; config.toml is never copied. */
  config: Record<string, unknown>;
  /** The origin URL carries no credentials (userinfo is stripped at export). */
  repository: { origin: string | null; branch: string };
  transcripts: TranscriptRecord[];
  files: { path: string; size: number; sha256: string }[];
}
export interface BundleFile { path: string; bytes: Uint8Array }

const ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const ALLOWED = [
  new RegExp(`^transcripts/${ID}\\.jsonl$`), /^tasks\.json$/, /^state\.json$/, new RegExp(`^questions/${ID}\\.json$`),
  new RegExp(`^images/${UUID}\\.(png|jpg|gif|webp)$`), new RegExp(`^image-inputs/${UUID}\\.json$`),
];
/** Path segments that must never appear in a bundle, whatever the allowlist says. */
const FORBIDDEN_SEGMENT = /^(auth|credentials?|\.credentials\.json|config\.toml|login-url\.txt|launches|runs|inbox|merged|locks?|tmux|input-epoch|input-history|repository\.json|repo|worktrees|\.git|\.ssh|tool-outputs|memory\.sqlite.*|id_(rsa|ed25519|ecdsa).*|.*\.(pem|key|exit|launch|cancel|lock|tmp|pending|sqlite|db))$/i;

/** Allowlist plus a defensive scan for credential-like or in-process paths. Throws a readable reason. */
export function assertBundlePath(path: string): void {
  if (path === "manifest.json") return;
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new Error(`unsafe bundle path ${JSON.stringify(path)}`);
  const segments = path.split("/");
  if (segments.some(s => s === "" || s === "." || s === "..")) throw new Error(`unsafe bundle path ${JSON.stringify(path)}`);
  const bad = segments.find(s => FORBIDDEN_SEGMENT.test(s));
  if (bad) throw new Error(`bundle path ${path} matches a credential/in-process pattern (${bad}); refusing`);
  if (!ALLOWED.some(rx => rx.test(path))) throw new Error(`bundle path ${path} is not on the transferable allowlist`);
}

export function encodeBundle(manifest: BundleManifest, files: BundleFile[]): Buffer {
  const parts: Buffer[] = [MAGIC];
  const record = (path: string, bytes: Uint8Array) => {
    const header = Buffer.from(JSON.stringify({ path, size: bytes.length })), length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    parts.push(length, header, Buffer.from(bytes));
  };
  record("manifest.json", Buffer.from(JSON.stringify(manifest)));
  for (const file of files) { assertBundlePath(file.path); record(file.path, file.bytes); }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

const validSize = (size: unknown): size is number => typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE;
/** One frame: a length-prefixed JSON {path, size} and its payload. Returns the record and the next position. */
function frame(buf: Buffer, at: number): { path: string; bytes: Buffer; next: number } | null {
  if (at + 4 > buf.length) throw new Error("truncated session bundle");
  const length = buf.readUInt32BE(at), start = at + 4;
  if (length === 0) return null;
  if (length > 4096 || start + length > buf.length) throw new Error("corrupt session bundle header");
  const { path, size } = JSON.parse(buf.toString("utf8", start, start + length)) as { path?: unknown; size?: unknown };
  if (typeof path !== "string" || !validSize(size)) throw new Error("corrupt session bundle record");
  const body = start + length;
  if (body + size > buf.length) throw new Error("truncated session bundle");
  return { path, bytes: buf.subarray(body, body + size), next: body + size };
}

/** Parse and bound-check frames; content validation happens in the importer. */
export function decodeBundle(input: Uint8Array): { manifest: unknown; files: BundleFile[] } {
  const buf = Buffer.from(input);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an orca session bundle (ssh banner or wrong command output?)");
  const files: BundleFile[] = [], seen = new Set<string>();
  let pos = MAGIC.length, total = 0;
  for (let f = frame(buf, pos); f; f = frame(buf, pos)) {
    total += f.bytes.length;
    if (seen.has(f.path) || files.length >= MAX_FILES || total > MAX_TOTAL) throw new Error(`duplicate or excessive bundle records (${f.path})`);
    seen.add(f.path);
    files.push({ path: f.path, bytes: f.bytes });
    pos = f.next;
  }
  if (pos + 4 !== buf.length) throw new Error("trailing bytes after session bundle");
  const [first, ...rest] = files;
  if (first?.path !== "manifest.json") throw new Error("session bundle has no manifest first");
  return { manifest: JSON.parse(Buffer.from(first.bytes).toString("utf8")), files: rest };
}

// ---- manifest validation: a forged or newer manifest is refused, never guessed at ----

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const count = (v: unknown, max = 10_000_000): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const stamp = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

function versionProblems(m: Rec): string[] {
  const schemas = isRec(m.schemas) ? m.schemas : {};
  const limits: [string, unknown, number][] = [
    ["manifest", m.manifestVersion, MANIFEST_VERSION], ["layout", m.layoutVersion, LAYOUT_VERSION],
    ["tasks schema", schemas.tasks, SCHEMAS.tasks], ["state schema", schemas.state, SCHEMAS.state],
  ];
  return limits.filter(([, v, max]) => positive(v) && v > max).map(([what, v, max]) => `${what} v${v} (understand v${max})`);
}

function checkShape(m: Rec): void {
  const schemas = m.schemas, model = m.model, repo = m.repository;
  if (!isRec(schemas) || !positive(m.manifestVersion) || !positive(m.layoutVersion) || !positive(schemas.tasks) || !positive(schemas.state)) throw new Error("invalid manifest versions");
  if (!text(m.orcaVersion, 64) || !text(m.sessionId, 64) || !text(m.name, 200) || !text(m.folderId, 128) || !text(m.host, 255) || !stamp(m.exportedAt)) throw new Error("incomplete manifest");
  if (!isRec(model) || !text(model.effective, 200) || !isRec(model.settings)) throw new Error("invalid manifest model");
  if (!isRec(m.config)) throw new Error("invalid manifest config");
  if (!isRec(repo) || !(repo.origin === null || text(repo.origin, 2048)) || typeof repo.branch !== "string" || repo.branch.length > 250) throw new Error("invalid manifest repository");
  if (!Array.isArray(m.transcripts) || m.transcripts.length > 1000 || !Array.isArray(m.files) || m.files.length > MAX_FILES) throw new Error("invalid manifest lists");
  for (const t of m.transcripts) {
    if (!isRec(t) || !text(t.id, 128) || !count(t.entries) || !hex(t.ledgerDigest) || !hex(t.contextDigest) || !count(t.chainMessages)) throw new Error("invalid manifest transcript record");
  }
  for (const f of m.files) if (!isRec(f) || !text(f.path, 300) || !validSize(f.size) || !hex(f.sha256)) throw new Error("invalid manifest file record");
}

/** The manifest shape and versions; newer-than-understood bundles are refused, never guessed at. */
export function checkManifest(raw: unknown): BundleManifest {
  if (!isRec(raw)) throw new Error("invalid manifest");
  const newer = versionProblems(raw);
  if (newer.length) throw new Error(`bundle is newer than this orca (${orcaVersion}) understands: ${newer.join("; ")}. Update this machine's orca (bundle made by orca ${String(raw.orcaVersion).slice(0, 64)}).`);
  checkShape(raw);
  return raw as unknown as BundleManifest;
}
