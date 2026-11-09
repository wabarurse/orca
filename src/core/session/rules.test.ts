// Session-transfer safety rules: integrity, versions, exclusions, quiescence, names, adoption, forged bundles and the
// ssh boundary. Two throwaway machines with temp ORCA_HOMEs; fake data only, no provider, tmux or network.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { conversationIds, paths, writeProjectState } from "../../config";
import { sessionImageScope } from "../data/images";
import { conversationTurnLock } from "../data/projects";
import { readSession } from "../data/projects/session-id";
import { assertBundlePath, assertBundleSize, decodeBundle, encodeBundle, sha256, type BundleManifest } from "./bundle";
import { exportSession } from "./export";
import { chainOf, ledgerDigest, ledgerOf } from "./ledger";
import { importSession } from "./import";
import { resolveSelector } from "./local";
import { SSH_OPTIONS } from "../../cli/session";
import { at, cleanup, holdLock, loopback, machine, project, quiet, say, session, type Machine } from "../../test/session-fixture";

afterAll(cleanup);

async function pair() {
  const a = await machine("mac"), b = await machine("server");
  await project(a, "orch-aaaa", "demo");
  await say(a, "orch-aaaa", ["hello", "hi there"]);
  return { a, b };
}
async function synced(a: Machine, b: Machine) {
  const r = await session(a, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  expect(r.code).toBe(0);
  return at(b, () => resolveSelector("demo"));
}
const bundleOf = (m: Machine, selector = "demo") => at(m, async () => (await exportSession(await resolveSelector(selector), quiet())).bundle);
/** Re-encode a bundle after `change`, keeping the manifest's file hashes consistent. */
function retool(bytes: Uint8Array, change: (manifest: BundleManifest, files: { path: string; bytes: Uint8Array }[]) => void) {
  const { manifest, files } = decodeBundle(bytes);
  const m = manifest as BundleManifest;
  change(m, files);
  m.files = files.map(f => ({ path: f.path, size: f.bytes.length, sha256: sha256(f.bytes) }));
  return encodeBundle(m, files);
}
/** A forged transcript with correct digests: the receiver must still refuse it on its own rules. */
async function forge(bytes: Uint8Array, edit: (text: string) => string) {
  const { manifest, files } = decodeBundle(bytes);
  const m = manifest as BundleManifest, scope = sessionImageScope(m.sessionId);
  const file = files.find(f => f.path === "transcripts/orchestrator.jsonl")!;
  const text = edit(Buffer.from(file.bytes).toString("utf8"));
  file.bytes = Buffer.from(text);
  const ledger = ledgerOf(text.replace(/"type":"from-the-future"/g, '"type":"message"'), [scope]), chain = await chainOf(text);
  const record = m.transcripts.find(t => t.id === "orchestrator")!;
  Object.assign(record, { entries: ledger.entries.length, ledgerDigest: ledgerDigest(ledger), contextDigest: chain.digest, chainMessages: chain.messages });
  m.files = files.map(f => ({ path: f.path, size: f.bytes.length, sha256: sha256(f.bytes) }));
  return encodeBundle(m, files);
}
const into = (m: Machine, bytes: Uint8Array, checkout?: string, opts: object = {}) => at(m, () => importSession(bytes, quiet(), { peer: "test", checkout, ...opts }));
const refuses = (p: Promise<unknown>, text: string) => expect(p).rejects.toThrow(text);

test("a tampered manifest digest, or a staged byte changed after staging, aborts and publishes nothing", async () => {
  const { a, b } = await pair();
  const good = await bundleOf(a);
  await refuses(into(b, retool(good, m => { m.transcripts[0]!.contextDigest = "0".repeat(64); }), b.repo), "contextDigest mismatch");
  await refuses(into(b, retool(good, m => { m.transcripts[0]!.ledgerDigest = "f".repeat(64); }), b.repo), "ledger digest mismatch");
  const tamper = async (point: string, stage: string) => {
    if (point !== "staged") return;
    for (const name of await readdir(join(stage, "files"))) {
      const p = join(stage, "files", name), text = await Bun.file(p).text();
      if (text.includes("hello")) await writeFile(p, text.replace("hello", "hellp"));
    }
  };
  await refuses(into(b, good, b.repo, { hook: tamper }), "differs from the exported ledger; nothing was published");
  expect(await at(b, () => conversationIds(paths.root))).toEqual([]);
  expect(await at(b, () => readdir(join(paths.root, "sync-staging")))).toEqual([]);
  expect((await into(b, good, b.repo)).outcome).toBe("created");
});

test("a bundle from a newer manifest, layout or schema is refused, and a malformed manifest is refused", async () => {
  const { a, b } = await pair();
  const good = await bundleOf(a);
  for (const edit of [(m: BundleManifest) => { m.manifestVersion = 2; }, (m: BundleManifest) => { m.layoutVersion = 99; }, (m: BundleManifest) => { m.schemas.tasks = 2; }, (m: BundleManifest) => { m.schemas.state = 2; }]) {
    await refuses(into(b, retool(good, m => edit(m)), b.repo), "newer than this orca");
  }
  const bad: [string, (m: BundleManifest) => void][] = [
    ["incomplete manifest", m => { (m as unknown as Record<string, unknown>).sessionId = 5; }],
    ["invalid manifest transcript record", m => { m.transcripts[0]!.entries = -1; }],
    ["invalid manifest transcript record", m => { (m.transcripts[0] as unknown as Record<string, unknown>).ledgerDigest = "short"; }],
    ["invalid manifest file record", m => { m.files.push({ path: "x", size: 2 ** 40, sha256: "0".repeat(64) }); }],
    ["invalid manifest versions", m => { (m.schemas as unknown as Record<string, unknown>).tasks = "1"; }],
    ["invalid manifest model", m => { (m.model as unknown as Record<string, unknown>).settings = []; }],
    ["invalid manifest lists", m => { (m as unknown as Record<string, unknown>).transcripts = "none"; }],
  ];
  for (const [message, edit] of bad) {
    const { manifest, files } = decodeBundle(good), m = manifest as BundleManifest;
    edit(m);
    await refuses(into(b, encodeBundle(m, files), b.repo), message);
  }
  expect(await at(b, () => existsSync(join(paths.root, "projects")))).toBe(false);
});

test("forged bundles are refused by the receiver on its own rules: unknown entry type, unpaired tool call, foreign image scope", async () => {
  const { a, b } = await pair();
  const good = await bundleOf(a);
  const line = (extra: object) => JSON.stringify({ uuid: randomUUID(), ts: "2026-01-01T00:00:00.000Z", parentUuid: null, ...extra }) + "\n";
  const future = await forge(good, t => t + line({ type: "from-the-future" }));
  await refuses(into(b, future, b.repo), "unknown entry type");
  const unpaired = await forge(good, t => t + line({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] } }));
  await refuses(into(b, unpaired, b.repo), "unpaired");
  const image = await forge(good, t => t + line({ type: "message", message: { role: "user", content: [{ type: "image", source: { type: "url", url: `orca-image:${"a".repeat(64)}:${randomUUID()}:${"b".repeat(64)}` } }] } }));
  await refuses(into(b, image, b.repo), "outside this session's scope");
  expect(await at(b, () => existsSync(join(paths.root, "projects")))).toBe(false);
});

test("live agents, unknown liveness, running runs and non-empty inboxes refuse export and import", async () => {
  const { a, b } = await pair();
  const id = await synced(a, b);
  const sel = (deps: Parameters<typeof quiet>[0]) => session(a, ["push", "demo", "server"], { transport: loopback(b), deps: quiet({ hostname: () => "mac", ...deps }) });
  expect((await sel({ live: async () => ["worker-feat-x"] })).err).toContain("agents are live (worker-feat-x)");
  expect((await sel({ live: async () => null })).err).toContain("liveness unknown");
  await at(a, async () => { await mkdir(paths.runs("orch-aaaa"), { recursive: true }); await writeFile(join(paths.runs("orch-aaaa"), "r1.json"), JSON.stringify({ run: "r1", state: "running", pid: 4242, role: "worker" })); });
  expect((await sel({ alive: pid => pid === 4242 })).err).toContain("still running (pid 4242)");
  expect((await sel({ alive: () => false })).code).toBe(0); // a dead pid is not live
  await at(a, async () => { await mkdir(join(paths.inbox("orch-aaaa"), "orchestrator"), { recursive: true }); await writeFile(join(paths.inbox("orch-aaaa"), "orchestrator", "1.json"), "{}"); });
  const inbox = await sel({});
  expect(inbox.code).toBe(1);
  expect(inbox.err).toContain("inbox has 1 undelivered");
  expect(inbox.err).toContain("let the agent drain it first");
  await say(a, "orch-aaaa", ["more", "text"]);
  await at(a, () => Bun.$`rm -rf ${paths.inbox("orch-aaaa")}`.quiet());
  const dest = await session(a, ["push", "demo", "server"], { transport: loopback(b, quiet({ hostname: () => "server", live: async () => ["orchestrator"] })) });
  expect(dest.code).toBe(1);
  expect(dest.err).toContain("agents are live (orchestrator)");
  await at(b, async () => { await mkdir(join(paths.inbox(id), "worker-feat-x"), { recursive: true }); await writeFile(join(paths.inbox(id), "worker-feat-x", "1.json"), "{}"); });
  const full = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(full.err).toContain("worker-feat-x's inbox has 1 undelivered");
});

test("a turn in progress refuses export and import", async () => {
  const { a, b } = await pair();
  const id = await synced(a, b);
  const release = await at(a, () => holdLock(conversationTurnLock("orch-aaaa")));
  const held = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  release();
  expect(held.code).toBe(1);
  expect(held.err).toContain("a turn is in progress");
  await say(a, "orch-aaaa", ["more", "text"]);
  const releaseB = await at(b, () => holdLock(conversationTurnLock(id)));
  const dest = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  releaseB();
  expect(dest.code).toBe(1);
  expect(dest.err).toContain("a turn is in progress");
  expect((await session(a, ["push", "demo", "server"], { transport: loopback(b) })).code).toBe(0);
});

test("only one import runs at a time on a machine", async () => {
  const { a, b } = await pair();
  const good = await bundleOf(a);
  const release = await at(b, () => holdLock(join(paths.runtime, "session-import.lock")));
  await refuses(into(b, good, b.repo), "another session import is running");
  release();
  expect(await at(b, () => conversationIds(paths.root))).toEqual([]);
  expect((await into(b, good, b.repo)).outcome).toBe("created");
});

test("only allowlisted files are exported; credentials and in-process state never are, and the path scan aborts an import", async () => {
  const { a, b } = await pair();
  await at(a, async () => {
    const d = paths.project("orch-aaaa");
    for (const rel of ["auth/anthropic/token.json", "config.toml", "login-url.txt", "memory.sqlite", "launches/x.json", "merged/1", "input-epoch", "input-history", "tool-outputs/o.txt", "transcript/orchestrator.jsonl.launch", "transcript/evil.key", "images/prepared/p.jpg"]) {
      await mkdir(join(d, rel, ".."), { recursive: true }); await writeFile(join(d, rel), "FAKE-SECRET-TOKEN");
    }
    await mkdir(paths.questions("orch-aaaa"), { recursive: true });
    await writeFile(join(paths.questions("orch-aaaa"), "q1.closed"), "FAKE-SECRET-TOKEN");
  });
  const bundle = await bundleOf(a);
  const { manifest, files } = decodeBundle(bundle);
  expect(files.map(f => f.path).sort()).toEqual(["state.json", "tasks.json", "transcripts/orchestrator.jsonl"]);
  expect(Buffer.from(bundle).includes("FAKE-SECRET-TOKEN")).toBe(false);
  expect((manifest as BundleManifest).transcripts.map(t => t.id)).toEqual(["orchestrator"]);
  for (const path of ["auth/x", "config.toml", "login-url.txt", "memory.sqlite", "launches/x", "runs/x.json", "inbox/x", "merged/x", "input-epoch", "tool-outputs/x", "transcripts/evil.pem", "transcripts/x.exit", "../escape", "/abs", "transcripts/../x.jsonl", "notes.txt"]) {
    expect(() => assertBundlePath(path)).toThrow();
  }
  for (const evil of ["auth/anthropic.json", "memory.sqlite-wal"]) {
    const { manifest: m, files: f } = decodeBundle(bundle);
    const hostile = [...f, { path: evil, bytes: Buffer.from("FAKE-SECRET-TOKEN") }];
    (m as BundleManifest).files = hostile.map(x => ({ path: x.path, size: x.bytes.length, sha256: sha256(x.bytes) }));
    const parts: Buffer[] = [Buffer.from("ORCA-SESSION-BUNDLE\n")];
    const frame = (path: string, bytes: Uint8Array) => { const h = Buffer.from(JSON.stringify({ path, size: bytes.length })), l = Buffer.alloc(4); l.writeUInt32BE(h.length); parts.push(l, h, Buffer.from(bytes)); };
    frame("manifest.json", Buffer.from(JSON.stringify(m)));
    for (const x of hostile) frame(x.path, x.bytes);
    parts.push(Buffer.alloc(4));
    await refuses(into(b, Buffer.concat(parts), b.repo), "credential/in-process pattern");
  }
});

test("legacy clone-based projects are refused at export and as a destination", async () => {
  const { a, b } = await pair();
  await at(a, async () => { await mkdir(join(paths.project("legacy-1"), "repo"), { recursive: true }); });
  const r = await session(a, ["export", "legacy-1", join(a.dir, "l.bundle")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("legacy clone-based project");
  expect(existsSync(join(a.dir, "l.bundle"))).toBe(false);
  expect(await at(a, () => existsSync(join(paths.project("legacy-1"), "session.json")))).toBe(false);
  await at(b, async () => { await mkdir(join(paths.project("legacy-b"), "repo"), { recursive: true }); writeProjectState("legacy-b", "name", "demo"); });
  // the legacy project is not listed (no binding, repo/ exists): listProjects keeps it, the name matches, it has no session id -> adoption needed, then refused as legacy
  const dest = await session(a, ["push", "demo", "server", "--checkout", b.repo, "--adopt"], { transport: loopback(b) });
  expect(dest.code).toBe(1);
  expect(dest.err).toContain("legacy clone-based project");
});

test("an unpaired tool call chain and an unknown entry type are refused at export; nothing is written", async () => {
  const { a } = await pair();
  await at(a, async () => {
    const { open } = await import("../data/transcripts");
    await open(paths.transcript("orch-aaaa", "orchestrator")).append({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] } });
  });
  const r = await session(a, ["export", "demo", join(a.dir, "u.bundle")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("unpaired");
  expect(existsSync(join(a.dir, "u.bundle"))).toBe(false);
  const { a: a2 } = await pair();
  await at(a2, () => appendFile(paths.transcript("orch-aaaa", "orchestrator"), JSON.stringify({ uuid: randomUUID(), type: "from-the-future", ts: "2026-01-01T00:00:00.000Z" }) + "\n"));
  const f = await session(a2, ["export", "demo", join(a2.dir, "f.bundle")]);
  expect(f.code).toBe(1);
  expect(f.err).toContain("unknown entry type");
});

test("display names are validated with /rename's rules on export, import and --as", async () => {
  const { a, b } = await pair();
  const good = await bundleOf(a);
  for (const bad of ["x\u202ey", "tab\there", "", "y".repeat(41), "\u0085nel"]) {
    await refuses(into(b, retool(good, m => { m.name = bad === "" ? " " : bad; }), b.repo), "names are 1-40 printable characters");
    const r = await session(a, ["push", "demo", "server", "--as", bad === "" ? " " : bad, "--checkout", b.repo], { transport: loopback(b) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("1-40 printable characters");
  }
  await at(a, () => writeProjectState("orch-aaaa", "name", "evil\u202ename"));
  const exp = await session(a, ["export", "orch-aaaa", join(a.dir, "n.bundle")]);
  expect(exp.code).toBe(1);
  expect(exp.err).toContain("1-40 printable characters");
  expect(await at(b, () => existsSync(join(paths.root, "projects")))).toBe(false);
});

test("an origin URL with credentials is stripped at export and a bundle carrying one is refused", async () => {
  const a = await machine("mac", "https://builder:s3cret-token@example.invalid/org/repo.git"), b = await machine("server");
  await project(a, "orch-aaaa", "demo"); await say(a, "orch-aaaa", ["hello", "hi"]);
  const bundle = await bundleOf(a);
  const manifest = decodeBundle(bundle).manifest as BundleManifest;
  expect(manifest.repository.origin).toBe("https://example.invalid/org/repo.git");
  expect(Buffer.from(bundle).includes("s3cret-token")).toBe(false);
  expect((await into(b, bundle, b.repo)).outcome).toBe("created");
  await refuses(into(await machine("c"), retool(bundle, m => { m.repository.origin = "https://u:pw@example.invalid/org/repo.git"; }), b.repo), "credentials in its origin URL");
});

test("same-named local projects: --adopt merges a project that has no session id, a different session is a collision, several are refused", async () => {
  const { a, b } = await pair();
  // b has an unrelated, never-exported project of the same name
  await project(b, "orch-bbbb", "demo");
  const noAdopt = await session(a, ["push", "demo", "server"], { transport: loopback(b) });
  expect(noAdopt.code).toBe(1);
  expect(noAdopt.err).toContain("--adopt");
  expect(await at(b, () => readSession("orch-bbbb"))).toBeUndefined();
  const adopted = await session(a, ["push", "demo", "server", "--adopt"], { transport: loopback(b) });
  expect(adopted.code).toBe(0);
  expect(adopted.err).toContain("adopted");
  expect(await at(b, () => readSession("orch-bbbb")!.sessionId)).toBe(await at(a, () => readSession("orch-aaaa")!.sessionId));
  // a different session of the same name is never merged
  const c = await machine("third");
  await project(c, "orch-cccc", "demo"); await say(c, "orch-cccc", ["other", "story"]);
  const collide = await session(c, ["push", "demo", "server", "--checkout", b.repo], { transport: loopback(b) });
  expect(collide.code).toBe(1);
  expect(collide.err).toContain("different session");
  expect(collide.err).toContain("--as");
  // several same-named candidates: refused, the last one never silently wins
  const d = await machine("fourth"), e = await machine("fifth");
  await project(e, "orch-eee1", "demo"); await project(e, "orch-eee2", "demo2");
  await at(e, () => writeProjectState("orch-eee2", "name", "demo"));
  await project(d, "orch-dddd", "demo"); await say(d, "orch-dddd", ["d", "story"]);
  const many = await session(d, ["push", "demo", "fifth", "--adopt"], { transport: loopback(e) });
  expect(many.code).toBe(1);
  expect(many.err).toContain("2 other projects");
  expect(await at(e, () => readSession("orch-eee1"))).toBeUndefined();
  expect(await at(e, () => readSession("orch-eee2"))).toBeUndefined();
});

test("offline export then import; ssh banners around the bundle and the result line are tolerated; export files are private and not overwritten", async () => {
  const { a, b } = await pair();
  const file = join(a.dir, "offline.bundle");
  expect((await session(a, ["export", "demo", file])).code).toBe(0);
  expect(((await Bun.file(file).stat()).mode & 0o777).toString(8)).toBe("600");
  const again = await session(a, ["export", "demo", file]);
  expect(again.code).toBe(1);
  expect(again.err).toContain("--force");
  expect((await session(a, ["export", "demo", file, "--force"])).code).toBe(0);
  const r = await session(b, ["import", file, "--checkout", b.repo]);
  expect(r.code).toBe(0);
  expect(r.err).toContain("created");
  const noCheckout = await session(await machine("c"), ["import", file]);
  expect(noCheckout.code).toBe(1);
  expect(noCheckout.err).toContain("--checkout");
  const c = await machine("d");
  const noisy = (peer: Machine) => { const inner = loopback(peer); return async (h: string, cmd: string, stdin?: Uint8Array) => { const out = await inner(h, cmd, stdin); return { ...out, out: Buffer.concat([Buffer.from("Welcome to the server\nLast login: never\n"), out.out]) }; }; };
  const pulled = await session(c, ["pull", "demo", "server", "--checkout", c.repo], { transport: noisy(a) });
  expect(pulled.code).toBe(0);
  expect(pulled.err).toContain("pulled from server");
  const e = await machine("e");
  const pushed = await session(a, ["push", "demo", "server", "--checkout", e.repo], { transport: noisy(e) });
  expect(pushed.code).toBe(0);
  expect(pushed.err).toContain("created");
});

test("the ssh boundary: remote commands are exact and quoted, host options are refused, and the sender's warnings survive a pull", async () => {
  const { a, b } = await pair();
  const log: string[] = [];
  await at(a, async () => { await mkdir(join(paths.project("orch-aaaa"), "images", "prepared"), { recursive: true }); await writeFile(join(paths.project("orch-aaaa"), "images", "prepared", "p.jpg"), "x"); });
  const pushed = await session(a, ["push", "demo", "server", "--checkout", "/tmp/it's here", "--dry-run"], { transport: loopback(b, undefined, log) });
  expect(log[0]).toBe("server: orca session receive '--checkout' '/tmp/it'\\''s here' '--dry-run' '--peer' 'mac'");
  expect(pushed.code).toBe(1); // the quoted path round-trips intact and does not exist
  expect(pushed.err).toContain("--checkout /tmp/it's here does not exist");
  const pulled = await session(b, ["pull", "demo", "mac", "--checkout", b.repo], { transport: loopback(a, undefined, log) });
  expect(log[1]).toBe("mac: orca session send 'demo'");
  expect(pulled.code).toBe(0);
  expect(pulled.err).toContain("note (from mac): not carried");
  expect(pulled.err).toContain("secrets");
  const dash = await session(a, ["push", "demo", "-oProxyCommand=evil"], { transport: loopback(b) });
  expect(dash.code).toBe(1);
  expect(SSH_OPTIONS).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]);
});

test("an export over the bundle size limits is refused with a message naming the limit", () => {
  const huge = (path: string, length: number) => ({ path, bytes: { length } as Uint8Array });
  expect(() => assertBundleSize([huge("transcripts/orchestrator.jsonl", 2 * 1024 ** 3)])).toThrow("per-file limit");
  expect(() => assertBundleSize([1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => huge(`images/${i}.png`, 1024 ** 3)))).toThrow("limit of a session bundle");
  expect(() => assertBundleSize([huge("tasks.json", 10)])).not.toThrow();
});
